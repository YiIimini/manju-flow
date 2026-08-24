// ═══════════════════════════════════════════════════════════════════════════
// 漫剧一条龙 Manju Flow — 自研渲染引擎（零 NiliX 依赖）
// 直连：ComfyUI(8190) 驱动 H3 工作流 + DeepSeek(OpenAI 兼容) 出方案/提示词
//      + FFmpeg/ffprobe 本地合成/质检。状态与日志全部落盘到项目 workdir，
//      status/kill 纯本地，不依赖任何 127.0.0.1:8787 服务。
//
// 设计（对照 NiliX internal 源码移植）：
//   M0 基建     HTTP 双通道(fetch 优先 + pwsh 兜底) / fs / 路径解析 / H3 合规
//   M1 工作流    wfZImage(资产) / h3EncWorkflow(条件编码) / h3RenderWorkflow(采样)
//   M2 方案     plan：LLM 直出 角色/场景/分镜 + 逐镜 H3 提示词(六段式/三段式)
//   M3 资产     assets：定妆照 + 场景图(Z-Image)
//   M4 渲染     render：逐镜 编码→采样→取回（含接缝 latent 链）
//   M5 合成质检  assemble(FFmpeg) / qc(ffprobe) / run_state / run.log
// ═══════════════════════════════════════════════════════════════════════════

'use strict'

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')

// ─────────────────────────────────────────────────────────────────────────────
// 常量（与 NiliX 部署一致）
// ─────────────────────────────────────────────────────────────────────────────
const NOVEL_ROOT = process.env.NOVEL_ROOT || 'C:/Mi/Ai/WorkBench/novel'
const MANJU_SELF = process.env.MANJU_ROOT || 'C:/Mi/Ai/WorkBench/NiliX/manju'
const MANJU_LEGACY = 'C:/Mi/Ai/WorkBench/manju'
const NILIX_SERVER_CFG = process.env.NILIX_SERVER_CFG || 'C:/Mi/Ai/WorkBench/NiliX/server/settings.json'
// 部署默认路径：优先环境变量，兼容本机既有配置（开源友好）
const userProfile = process.env.DSH_USERPROFILE || process.env.USERPROFILE || 'C:/Users/Administrator'
const COM_INPUT_DEF = (process.env.COMFY_INPUT || (userProfile + '/AppData/Local/Comfy-Desktop/ComfyUI-Shared/input')).replace(/\\/g, '/')
const COM_OUTPUT_DEF = (process.env.COMFY_OUTPUT || 'C:/Mi/Ai/WorkBench/NiliX/ComfyUI/output').replace(/\\/g, '/')
const COM_URL_DEF = process.env.COMFY_URL || 'http://127.0.0.1:8190'
const FFMPEG_DIR_DEF = process.env.FFMPEG_DIR || (userProfile + '/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin')
const H3_STYLES = ['2.5d', 'real', '3d', 'anime', 'handdrawn', 'papercraft', 'clay', 'ink']
const DEEPSEEK_DEF = { base_url: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.4, max_tokens: 8192, request_timeout: 300 }

// 风格措辞表（对照 NiliX manjuStyles；asset=图片风格锚 / opening=Ref2VA 开场 / shot1=FL2VA 首行）
const MANJU_STYLES = {
  '2.5d': { asset: '2.5D semi-realistic digital art', opening: 'The target video is in a 2.5D semi-realistic digital art style, cinematic lighting', shot1: '[Shot 1] 2.5D semi-realistic digital art style, cinematic lighting' },
  'real': { asset: 'Live-action, photorealistic, cinematic film style', opening: 'The target video is in a live-action photorealistic cinematic film style, natural lighting', shot1: '[Shot 1] Live-action photorealistic cinematic film style, natural lighting' },
  '3d': { asset: '3D CG render, cinematic blockbuster style', opening: 'The target video is in a 3D CG cinematic blockbuster style, dramatic lighting', shot1: '[Shot 1] 3D CG cinematic blockbuster style, dramatic lighting' },
  'anime': { asset: '2D-animated, cel-shaded anime style', opening: 'The target video is in a 2D-animated cel-shaded anime style, soft lighting', shot1: '[Shot 1] 2D-animated cel-shaded anime style, soft lighting' },
  'handdrawn': { asset: 'hand-drawn illustration, painterly style', opening: 'The target video is in a hand-drawn illustration painterly style, warm lighting', shot1: '[Shot 1] hand-drawn illustration painterly style, warm lighting' },
  'papercraft': { asset: 'papercraft cut-out stop-motion style', opening: 'The target video is in a papercraft cut-out stop-motion style, soft studio lighting', shot1: '[Shot 1] papercraft cut-out stop-motion style, soft studio lighting' },
  'clay': { asset: 'claymation, plasticine art style', opening: 'The target video is in a claymation plasticine art style, warm studio lighting', shot1: '[Shot 1] claymation plasticine art style, warm studio lighting' },
  'ink': { asset: 'Chinese ink wash painting, traditional brushwork, minimalist', opening: 'The target video is in a Chinese ink wash painting style, traditional brushwork, minimalist, cinematic lighting', shot1: '[Shot 1] Chinese ink wash painting style, traditional brushwork' },
}

// 默认渲染参数（对应 NiliX manjuDefaultConfig.render）
function defaultRender() {
  return {
    width: 768, height: 1344, fps: 24, steps: 20, turbo_steps: 8, seed: 1688,
    min_shot_seconds: 4, max_shot_seconds: 12,
    comfy_url: COM_URL_DEF,
    neg_prompt: 'lowres, bad anatomy, bad hands, text, error, extra digit, no text, no watermark, no deformed hands, flickering frames, temporal discontinuity, inconsistent lighting',
    unet_fl2va: 'MiniMax_H3_fl2va_pruned_int8_convrot.safetensors',
    unet_ref2va: 'MiniMax_H3_ref2va_pruned_int8_convrot.safetensors',
    clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    vae_video: 'minimax_h3_video_vae_fp16.safetensors',
    vae_audio: 'minimax_h3_audio_vae_fp32.safetensors',
    z_image_unet: 'z_image_turbo_bf16.safetensors',
    z_image_clip: 'qwen_3_4b.safetensors',
    z_image_vae: 'ae.safetensors',
    turbo_lora: 'minimax_h3_turbo_4step_ema.safetensors',
    turbo_lora_r2v: 'minimax_h3_turbo_4step_ema.safetensors',
    animagine_ckpt: 'animagine-xl-3.1.safetensors',
    char_models: { '男': 'sd_xl_base_1.0.safetensors', '女': 'animagine-xl-3.1.safetensors' },
    chapters: '', episode: '0',
    // 2026-08-24 新增：FL2VA 空镜尾帧锚定（默认关闭，成本翻倍）
    fl2va_end_frame: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────
const str = (v, d) => (v === undefined || v === null) ? (d === undefined ? '' : d) : String(v)
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const has = (v) => v !== undefined && v !== null && String(v).trim() !== ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex')
const align32 = (n) => Math.max(128, Math.floor(n / 32) * 32)
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_')
const normPath = (p) => String(p || '').replace(/\\/g, '/')
const fullPath = (p) => path.resolve(String(p || '').replace(/\//g, path.sep))
// 时间戳：与 NiliX run.log 一致
const ts = () => { const d = new Date(); const p = (n, w) => String(n).padStart(w, '0'); return `[${p(d.getHours(),2)}:${p(d.getMinutes(),2)}:${p(d.getSeconds(),2)}]` }

// H3 帧数网格：17k+5 @fps（对应 NiliX h3Length）
function h3Length(seconds, fps) {
  const base = Math.max(5, Math.floor((seconds * fps + 1) / 2) * 2)
  const delta = ((5 - (base % 17)) % 17 + 17) % 17
  return base + delta
}

// 风格解析（组合 + 自定义英文）
function styleDesc(style) {
  if (MANJU_STYLES[style]) return MANJU_STYLES[style]
  const parts = String(style || '').split('+').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1) {
    const core = parts.map((p) => (MANJU_STYLES[p] ? MANJU_STYLES[p].asset : p))
    const joined = core.join(', ')
    return { asset: joined, opening: 'The target video is in a ' + joined + ' style, cinematic realistic lighting', shot1: '[Shot 1] ' + joined + ' style, cinematic realistic lighting' }
  }
  const s = String(style || 'real')
  return { asset: s, opening: s, shot1: '[Shot 1] ' + s }
}
const styleHas = (style, key) => String(style || '').split('+').map((s) => s.trim()).includes(key)

// H3 合规摘要
function h3ComplianceOf(render) {
  const W = (render && render.width) || 768
  const H = (render && render.height) || 1344
  const shortEdge = Math.min(W, H)
  const over = shortEdge > 768 || W * H > 768 * 1344
  return {
    width: W, height: H, shortEdge,
    width32: W % 32 === 0, height32: H % 32 === 0,
    overArea: over, aligned: W % 32 === 0 && H % 32 === 0 && !over,
    note: 'H3 官方规格：短边 ≤768 且 32 倍数网格（draft 416 / standard 768 / fhd 1088）',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎工厂：接收 ctx（shell/fs 注入），返回全部阶段方法
// ─────────────────────────────────────────────────────────────────────────────
function createEngine(ctx) {
  const log = (...a) => console.log('[manju-engine]', ...a)
  const FULL_POLICY = { mode: 'danger-full-access', workspaceRoot: 'C:/Mi/Ai/WorkBench' }

  // ── M0 基建 ──────────────────────────────────────────────────────────────
  async function pwsh(lines, opts) {
    const shell = ctx.get('shell')
    if (!shell) throw new Error('shell 服务不可用')
    const req = { command: Array.isArray(lines) ? lines.join('\n') : lines, sandboxPolicy: FULL_POLICY }
    if (opts && opts.timeoutMs) req.timeoutMs = opts.timeoutMs
    if (opts && opts.stdoutMaxBytes) req.stdoutMaxBytes = opts.stdoutMaxBytes
    let spec = req
    try { if (typeof shell.resolve === 'function') { spec = shell.resolve(req); spec.sandboxPolicy = FULL_POLICY } } catch (e) { /* keep */ }
    const res = await shell.run(spec)
    const stdout = (res.stdout && res.stdout.text) || ''
    const stderr = (res.stderr && res.stderr.text) || ''
    const denied = !!(res.sandbox && res.sandbox.denied)
    if (opts && opts.strict && (res.exitCode !== 0 || denied)) {
      throw new Error('pwsh exit=' + res.exitCode + (denied ? ' [denied]' : '') + ': ' + (stdout + '\n' + stderr).trim().slice(0, 2000))
    }
    return { exitCode: res.exitCode, stdout, stderr, denied }
  }

  // HTTP GET（fetch 优先，pwsh 兜底；返回 {status, data|raw|error}）
  async function httpGet(url, timeoutMs) {
    if (typeof fetch === 'function') {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs || 30000)
      try {
        const res = await fetch(url, { signal: ac.signal })
        const text = await res.text()
        clearTimeout(t)
        try { return { status: res.status, data: JSON.parse(text) } } catch (e) { return { status: res.status, raw: text } }
      } catch (e) { clearTimeout(t); return { status: 0, error: String((e && e.message) || e) } }
    }
    const r = await pwsh(`try { $r = Invoke-RestMethod -Uri '${url}' -Method Get -TimeoutSec 60; $r | ConvertTo-Json -Depth 16 } catch { Write-Output ('__MF_ERR__' + $_.Exception.Message) }`, { timeoutMs: 90000, stdoutMaxBytes: 8 * 1024 * 1024 })
    const out = (r.stdout || '').trim()
    if (out.startsWith('__MF_ERR__')) return { status: 0, error: out.slice(10) }
    try { return { status: 200, data: JSON.parse(out) } } catch (e) { return { status: 200, raw: out } }
  }

  // HTTP POST JSON（fetch 优先）
  async function httpPost(url, body, headers, timeoutMs) {
    const json = JSON.stringify(body || {})
    if (typeof fetch === 'function') {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs || 60000)
      try {
        const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: json, signal: ac.signal })
        const text = await res.text()
        clearTimeout(t)
        try { return { status: res.status, data: JSON.parse(text) } } catch (e) { return { status: res.status, raw: text } }
      } catch (e) { clearTimeout(t); return { status: 0, error: String((e && e.message) || e) } }
    }
    const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
    const hs = Object.keys(h).map((k) => `'${k}'='${String(h[k]).replace(/'/g, "''")}'`).join('; ')
    const b = json.replace(/'/g, "''")
    const r = await pwsh([
      `$ErrorActionPreference = 'Stop'`,
      `$h = @{ ${hs} }`,
      `$b = '${b}'`,
      `try { $r = Invoke-RestMethod -Uri '${url}' -Method Post -Headers $h -Body $b -TimeoutSec 900; $r | ConvertTo-Json -Depth 16 } catch { $d = $_.ErrorDetails.Message; if (-not $d) { $d = $_.Exception.Message }; Write-Output ('__MF_ERR__' + $d) }`,
    ], { timeoutMs: 960000 })
    const out = (r.stdout || '').trim()
    if (out.startsWith('__MF_ERR__')) return { status: 0, error: out.slice(10).slice(0, 2000) }
    try { return { status: 200, data: JSON.parse(out) } } catch (e) { return { status: 200, raw: out } }
  }

  // 文件操作（关键读写走 node:fs，避免命令行长度/编码问题；其余走 pwsh）
  const fexists = async (p) => { try { return fs.existsSync(path.resolve(String(p).replace(/\//g, path.sep))) } catch (e) { return false } }
  const fread = async (p) => { const full = path.resolve(String(p).replace(/\//g, path.sep)); return fs.readFileSync(full, 'utf-8') }
  const fmkdir = async (p) => pwsh(`$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '${p}' | Out-Null`, { strict: true })
  const fcopy = async (s, d) => pwsh(`$ErrorActionPreference='Stop'; Copy-Item -LiteralPath '${s}' -Destination '${d}' -Force`, { strict: true })
  // 大文件安全写入：node:fs 直写（无命令行长度限制；目录自动创建）
  const fwrite = async (p, content) => {
    const full = path.resolve(String(p).replace(/\//g, path.sep))
    const parent = path.dirname(full)
    fs.mkdirSync(parent, { recursive: true })
    fs.writeFileSync(full, Buffer.from(String(content), 'utf-8'))
  }
  const fremove = async (p) => { try { fs.rmSync(path.resolve(String(p).replace(/\//g, path.sep)), { force: true }) } catch (e) { /* ignore */ } }
  async function listDir(p) {
    try { return fs.readdirSync(path.resolve(String(p).replace(/\//g, path.sep))) } catch (e) { return [] }
  }
  async function listFiles(p, filter) {
    try {
      const full = path.resolve(String(p).replace(/\//g, path.sep))
      const re = filter ? new RegExp('^' + String(filter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$') : null
      return fs.readdirSync(full).filter((f) => { try { return fs.statSync(path.join(full, f)).isFile() && (!re || re.test(f)) } catch (e) { return false } }).map((f) => normPath(path.join(full, f)))
    } catch (e) { return [] }
  }
  async function copyBinary(src, dst) {
    const d = String(dst)
    const parent = d.replace(/[\\/][^\\/]*$/, '')
    if (parent && parent !== d) await fmkdir(parent)
    const s = path.resolve(String(src).replace(/\//g, path.sep))
    const dd = path.resolve(d.replace(/\//g, path.sep))
    fs.copyFileSync(s, dd)
  }

  // ── 路径解析 ─────────────────────────────────────────────────────────────
  async function resolveManjuRoot() {
    if (await fexists(MANJU_SELF)) return MANJU_SELF
    return MANJU_LEGACY
  }
  const cfgPathOf = (project, manjuRoot) => manjuRoot + '/' + project + '/config.json'
  const projectDirOf = (cfgPath) => String(cfgPath).replace(/\/config\.json$/, '')
  async function readCfg(project, manjuRoot) {
    const cfgPath = cfgPathOf(project, manjuRoot)
    if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config', cfgPath }
    try { return { ok: true, cfgPath, cfg: JSON.parse(await fread(cfgPath)) } } catch (e) { return { ok: false, error: 'config.json 解析失败: ' + e.message, cfgPath } }
  }
  async function loadLLM(cfg) {
    const llm = Object.assign({}, DEEPSEEK_DEF, (cfg && cfg.llm) || {})
    if (!llm.api_key) {
      try { const k = JSON.parse(await fread(NILIX_SERVER_CFG)); if (k.api_key) llm.api_key = k.api_key } catch (e) { /* ignore */ }
    }
    return llm
  }
  // ComfyUI 目录（config.paths 优先，常量兜底）
  async function comfyDirs(cfg) {
    const paths = (cfg && cfg.paths) || {}
    return {
      input: normPath(paths.comfy_input || COM_INPUT_DEF),
      output: normPath(paths.comfy_output || COM_OUTPUT_DEF),
      url: (cfg && cfg.render && cfg.render.comfy_url) || COM_URL_DEF,
    }
  }

  // ── ComfyUI 客户端 ───────────────────────────────────────────────────────
  function comfyClient(base) {
    const B = String(base || COM_URL_DEF).replace(/\/+$/, '')
    return {
      async online() {
        const r = await httpGet(B + '/system_stats', 8000)
        if (r.status !== 200 || !r.data) return { online: false, error: r.error || ('HTTP ' + r.status) }
        const sys = r.data.system || {}
        const dev = (r.data.devices || [])[0] || {}
        return { online: true, comfyui_version: sys.comfyui_version, device: dev.name, vram_total: dev.vram_total }
      },
      async hasNode(name) {
        const r = await httpGet(B + '/object_info/' + encodeURIComponent(name), 8000)
        return r.status === 200
      },
      async submit(workflow) {
        const r = await httpPost(B + '/prompt', { prompt: workflow }, {}, 120000)
        if (r.status !== 200 || !r.data) return { ok: false, error: r.error || (r.raw ? String(r.raw).slice(0, 300) : 'HTTP ' + r.status) }
        const d = r.data
        if (d.node_errors && Object.keys(d.node_errors).length) return { ok: false, error: 'ComfyUI 节点错误: ' + JSON.stringify(d.node_errors).slice(0, 500) }
        if (!d.prompt_id) return { ok: false, error: 'ComfyUI 未返回 prompt_id: ' + JSON.stringify(d).slice(0, 300) }
        return { ok: true, prompt_id: d.prompt_id }
      },
      async history(promptId) {
        const r = await httpGet(B + '/history/' + encodeURIComponent(promptId), 20000)
        if (r.status !== 200 || !r.data) return null
        return r.data[promptId] || null
      },
      // 等待完成；返回 {ok, error}
      async wait(promptId, timeoutMs, pollMs) {
        const deadline = Date.now() + (timeoutMs || 3600000)
        while (Date.now() < deadline) {
          const entry = await this.history(promptId)
          if (entry) {
            const st = (entry.status && entry.status.status_str) || ''
            if (st === 'error') return { ok: false, error: 'ComfyUI 任务失败: ' + comfyErrMsg(entry.status) }
            if (entry.status && entry.status.completed) return { ok: true }
          }
          await sleep(pollMs || 10000)
        }
        return { ok: false, error: 'ComfyUI 等待超时(> ' + Math.round((timeoutMs || 3600000) / 60000) + ' 分钟)' }
      },
      // 提取输出媒体文件（video 优先 images）
      outputFiles(entry) {
        const out = []
        const outputs = (entry && entry.outputs) || {}
        for (const k of Object.keys(outputs)) {
          const node = outputs[k] || {}
          for (const key of ['video', 'images', 'audio']) {
            const arr = node[key] || []
            for (const m of arr) {
              if (m && m.filename) out.push({ filename: String(m.filename), subfolder: String(m.subfolder || ''), type: String(m.type || 'output') })
            }
          }
        }
        return out
      },
      outputVideo(entry) {
        const files = this.outputFiles(entry)
        const v = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename))
        if (v) return v
        return files.find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f.filename)) || null
      },
      // 取回文件到本地（优先本地 output 目录复制，失败走 /view 下载）
      async fetch(media, localDir) {
        if (!media) return { ok: false, error: '无媒体输出' }
        const rel = [media.subfolder, media.filename].filter(Boolean).join('/')
        const dst = localDir + '/' + rel.split('/').pop()
        await fmkdir(localDir)
        // 1) 本地 output 目录复制
        const outDir = normPath(COM_OUTPUT_DEF)
        if (media.type === 'output') {
          const src = outDir + '/' + rel
          if (await fexists(src)) { await copyBinary(src, dst); if (await fexists(dst)) return { ok: true, path: dst } }
        }
        // 2) /view 下载（fetch 二进制）
        const viewUrl = B + '/view?filename=' + encodeURIComponent(media.filename) + '&subfolder=' + encodeURIComponent(media.subfolder || '') + '&type=' + encodeURIComponent(media.type || 'output')
        if (typeof fetch === 'function') {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 300000)
          try {
            const res = await fetch(viewUrl, { signal: ac.signal })
            clearTimeout(t)
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer())
              const b64 = buf.toString('base64')
              const d64 = Buffer.from(dst, 'utf-8').toString('base64')
              await pwsh(`$ErrorActionPreference='Stop'; [System.IO.File]::WriteAllBytes([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${d64}')), [Convert]::FromBase64String('${b64}'))`, { strict: true })
              return { ok: true, path: dst }
            }
            return { ok: false, error: 'view HTTP ' + res.status }
          } catch (e) { clearTimeout(t); return { ok: false, error: String((e && e.message) || e) } }
        }
        return { ok: false, error: '无法取回产物（本地目录不存在且无 fetch）: ' + rel }
      },
    }
  }
  function comfyErrMsg(st) {
    const arr = (st && st.messages) || []
    for (const m of arr) { const d = m && m.data; if (d && d.exception_message) return String(d.exception_message).slice(0, 300) }
    return (st && st.exception_message) || '未知错误'
  }

  // ── DeepSeek LLM 客户端 ──────────────────────────────────────────────────
  async function llmChat(llm, messages, maxTokens, temperature) {
    const base = String(llm.base_url || DEEPSEEK_DEF.base_url).replace(/\/+$/, '')
    const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions'
    const body = {
      model: llm.model || DEEPSEEK_DEF.model,
      messages,
      max_tokens: maxTokens || 8192,
      temperature: temperature === undefined ? 0.4 : temperature,
      thinking: { type: 'disabled' },
    }
    const r = await httpPost(url, body, { Authorization: 'Bearer ' + llm.api_key }, (llm.request_timeout || 300) * 1000)
    if (r.status !== 200 || !r.data) return { ok: false, error: r.error || (r.raw ? String(r.raw).slice(0, 300) : 'LLM HTTP ' + r.status) }
    const d = r.data
    if (d.error) return { ok: false, error: 'LLM 错误: ' + (d.error.message || JSON.stringify(d.error)) }
    const c = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''
    if (!c) return { ok: false, error: 'LLM 返回空 choices' }
    return { ok: true, content: c }
  }
  // JSON 输出清洗（去 ```json 包裹，截取首个 { ... }）
  function extractJSON(s) {
    let t = String(s || '')
    const fence = t.indexOf('```')
    if (fence >= 0) {
      t = t.slice(fence + 3)
      const nl = t.indexOf('\n')
      if (nl >= 0 && t.slice(0, nl).trim().toLowerCase() === 'json') t = t.slice(nl + 1)
      const end = t.indexOf('```')
      if (end >= 0) t = t.slice(0, end)
    }
    t = t.trim()
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) t = t.slice(start, end + 1)
    return t
  }
  // 结构化 JSON 调用（LLM 直出对象）
  async function llmJSON(llm, sys, user, opts) {
    const r = await llmChat(llm, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], opts && opts.maxTokens, opts && opts.temperature)
    if (!r.ok) return { ok: false, error: r.error }
    try { return { ok: true, data: JSON.parse(extractJSON(r.content)) } }
    catch (e) { return { ok: false, error: 'LLM 输出非 JSON: ' + r.content.slice(0, 200), raw: r.content } }
  }

  // ── M1 工作流构建（对照 NiliX internal/render + api/manju_comfy.go）─────
  // 引用值：'N' → [N, 0]；'N[0]' → [N, 0]（通用）
  function refOf(id) {
    const m = String(id).match(/^(\d+)(?:\[(\d+)\])?$/)
    return [m[1], m[2] === undefined ? 0 : Number(m[2])]
  }
  function wfAdd(wf, classType, inputs) {
    const id = String(Object.keys(wf).length + 1)
    wf[id] = { class_type: classType, inputs: inputs || {} }
    return id
  }

  // Z-Image 文生图/图生图（场景图/定妆/多视图；8 步 turbo；initImage 非空 → img2img 保身份）
  // initImage: ComfyUI input 相对文件名(主图); initStrength: denoise 0-1(视图换视角用 0.7-0.85)
  function wfZImage(prompt, R, seed, w, h, prefix, neg, initImage, initStrength) {
    const wf = {}
    const mid = wfAdd(wf, 'UNETLoader', { unet_name: str(R.z_image_unet), weight_dtype: 'default' })
    const clipID = wfAdd(wf, 'CLIPLoader', { clip_name: str(R.z_image_clip), type: 'qwen_image' })
    const vaeID = wfAdd(wf, 'VAELoader', { vae_name: str(R.z_image_vae) })
    const pos = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(clipID), text: prompt })
    const negID = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(clipID), text: neg || '' })
    let latent
    let denoise = 1.0
    if (initImage) {
      const load = wfAdd(wf, 'LoadImage', { image: initImage })
      latent = wfAdd(wf, 'VAEEncode', { pixels: refOf(load), vae: refOf(vaeID) })
      denoise = (initStrength && initStrength > 0 && initStrength < 1) ? initStrength : 0.6
    } else {
      latent = wfAdd(wf, 'EmptySD3LatentImage', { width: w, height: h, batch_size: 1 })
    }
    const samp = wfAdd(wf, 'KSampler', { model: refOf(mid), positive: refOf(pos), negative: refOf(negID), latent_image: refOf(latent), seed, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise })
    const dec = wfAdd(wf, 'VAEDecode', { samples: refOf(samp), vae: refOf(vaeID) })
    wfAdd(wf, 'SaveImage', { images: refOf(dec), filename_prefix: prefix })
    return wf
  }
  // SDXL 文生图（动漫定妆照）
  function wfSDXL(prompt, ckpt, seed, w, h, prefix, neg) {
    const wf = {}
    const cid = wfAdd(wf, 'CheckpointLoaderSimple', { ckpt_name: ckpt })
    const pos = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(cid + '[1]'), text: prompt })
    const negID = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(cid + '[1]'), text: neg || '' })
    const latent = wfAdd(wf, 'EmptyLatentImage', { width: w, height: h, batch_size: 1 })
    const samp = wfAdd(wf, 'KSampler', { model: refOf(cid + '[0]'), positive: refOf(pos), negative: refOf(negID), latent_image: refOf(latent), seed, steps: 25, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 })
    const dec = wfAdd(wf, 'VAEDecode', { samples: refOf(samp), vae: refOf(cid + '[2]') })
    wfAdd(wf, 'SaveImage', { images: refOf(dec), filename_prefix: prefix })
    return wf
  }

  // H3 条件编码工作流（Qwen3-VL；有角色→ReferenceToVideo，空镜→ImageToVideo+first_frame）
  // ★ 2026-08-24 实测修复：ref_images 必须用 Autogrow 平铺键（ref_images.ref_image_0/1/2...），
  //   旧代码传数组会被 ComfyUI 新版静默忽略 → 参考图从未编进条件缓存 → 同场景镜头画面趋同。
  function h3EncWorkflow(R, prompt, w, h, length, charRefs, sceneRef, cacheName, hasChar, sceneEndRef) {
    const wf = {}
    const clip = wfAdd(wf, 'CLIPLoader', { clip_name: str(R.clip), type: 'minimax' })
    const vae = wfAdd(wf, 'VAELoader', { vae_name: str(R.vae_video) })
    const audioVae = wfAdd(wf, 'VAELoader', { vae_name: str(R.vae_audio) })
    let condID
    if (hasChar) {
      const inputs = { clip: refOf(clip), vae: refOf(vae), audio_vae: refOf(audioVae), prompt, width: w, height: h, length, ref_image_size: 'match' }
      const refs = []
      for (const cr of (charRefs || [])) { if (cr) refs.push(refOf(wfAdd(wf, 'LoadImage', { image: cr }))) }
      if (sceneRef) refs.push(refOf(wfAdd(wf, 'LoadImage', { image: sceneRef })))
      if (refs.length) {
        // 平铺键：ref_images.ref_image_0/1/2...（角色图在前，场景图最后）
        for (let i = 0; i < refs.length; i++) inputs['ref_images.ref_image_' + i] = refs[i]
      }
      condID = wfAdd(wf, 'MiniMaxH3ReferenceToVideo', inputs)
    } else {
      const inputs = { clip: refOf(clip), vae: refOf(vae), prompt, width: w, height: h, length }
      if (sceneRef) inputs.first_frame = refOf(wfAdd(wf, 'LoadImage', { image: sceneRef }))
      // 尾帧存在（fl2va_end_frame 开启 + 场景尾帧已生成）→ 首尾双帧插值（核心节点自带 last_frame）
      if (sceneEndRef) inputs.last_frame = refOf(wfAdd(wf, 'LoadImage', { image: sceneEndRef }))
      condID = wfAdd(wf, 'MiniMaxH3ImageToVideo', inputs)
    }
    wfAdd(wf, 'MiniMaxH3CondSave', { conditioning: refOf(condID), cache_name: cacheName })
    return wf
  }

  // H3 采样渲染工作流（CondLoad + Turbo LoRA + 可选 MotionContext 接缝）
  function h3RenderWorkflow(R, seed, w, h, length, steps, cacheName, hasChar, chained, prevIdx, curIdx) {
    const wf = {}
    let unetName = str(R.unet_ref2va)
    if (!hasChar) unetName = str(R.unet_fl2va)
    let model = wfAdd(wf, 'UNETLoader', { unet_name: unetName, weight_dtype: 'default' })
    // Turbo LoRA
    let loraName = str(R.turbo_lora)
    if (hasChar) { const r2v = str(R.turbo_lora_r2v); if (r2v) loraName = r2v }
    let sampler = 'res_multistep', scheduler = 'simple', loraSteps = steps
    if (/lightx2v|kijai/i.test(loraName)) {
      model = wfAdd(wf, 'LoraLoaderModelOnly', { model: refOf(model), lora_name: loraName, strength_model: 0.75 })
      sampler = 'sa_solver'; loraSteps = 4
    } else if (loraName) {
      model = wfAdd(wf, 'LoraLoaderModelOnly', { model: refOf(model), lora_name: loraName, strength_model: 0.8 })
      sampler = 'res_multistep'; loraSteps = R.turbo_steps || 8
    } else {
      loraSteps = steps
    }
    const vae = wfAdd(wf, 'VAELoader', { vae_name: str(R.vae_video) })
    const audioVae = wfAdd(wf, 'VAELoader', { vae_name: str(R.vae_audio) })
    let condID = wfAdd(wf, 'MiniMaxH3CondLoad', { cache_name: cacheName })
    const latentID = wfAdd(wf, 'EmptyMiniMaxH3LatentAV', { width: w, height: h, length })
    let trimFramesID = ''
    if (chained) {
      const latLoad = wfAdd(wf, 'MiniMaxH3MotionContextLoadLatent', { latent_path: 'h3_context', clip_index: prevIdx })
      const mc = wfAdd(wf, 'MiniMaxH3MotionContext', { conditioning: refOf(condID), vae: refOf(vae), latent: refOf(latentID), context_length: '22', audio_context_length: 24, context_latent: refOf(latLoad) })
      condID = mc + '[0]'; trimFramesID = mc + '[1]'
    }
    const guider = wfAdd(wf, 'BasicGuider', { model: refOf(model), conditioning: refOf(condID) })
    const noise = wfAdd(wf, 'RandomNoise', { noise_seed: seed })
    const sampSel = wfAdd(wf, 'KSamplerSelect', { sampler_name: sampler })
    const sched = wfAdd(wf, 'BasicScheduler', { model: refOf(model), scheduler, steps: loraSteps, denoise: 1.0 })
    const samp = wfAdd(wf, 'SamplerCustomAdvanced', { noise: refOf(noise), guider: refOf(guider), sampler: refOf(sampSel), sigmas: refOf(sched), latent_image: refOf(latentID) })
    let imgID = wfAdd(wf, 'VAEDecode', { samples: refOf(samp), vae: refOf(vae) })
    let audID = wfAdd(wf, 'VAEDecodeAudio', { samples: refOf(samp), vae: refOf(audioVae) })
    if (chained) {
      const trim = wfAdd(wf, 'MiniMaxH3MotionContextTrim', { images: refOf(imgID), trim_frames: refOf(trimFramesID), audio: refOf(audID), fps: R.fps || 24, match_tail: true })
      imgID = trim + '[0]'; audID = trim + '[1]'
    }
    const video = wfAdd(wf, 'CreateVideo', { images: refOf(imgID), fps: R.fps || 24, audio: refOf(audID) })
    wfAdd(wf, 'SaveVideo', { video: refOf(video), filename_prefix: 'manju', format: 'auto', codec: 'auto' })
    wfAdd(wf, 'MiniMaxH3MotionContextSaveLatent', { latent: refOf(samp), filename_prefix: 'h3_context/clip', clip_index: curIdx })
    return wf
  }

  // ── 小说素材扫描（对照 NiliX scanNovelAssets）──────────────────────────
  async function scanNovelAssets(root) {
    const out = { CharPrompt: '', ScenePrompt: '', ExtraPrompt: '', Setting: '', CoverPrompt: '', Files: [] }
    if (!root) return out
    const readTrunc = async (p) => { if (!(await fexists(p))) return ''; let t = await fread(p); if (t.length > 8000) t = t.slice(0, 8000); return t }
    const add = (name, content) => { if (content) out.Files.push(name) }
    const dir = root + '/素材'
    if (await fexists(dir)) {
      for (const f of await listFiles(dir, '*.md')) {
        const low = String(f.split('/').pop()).toLowerCase()
        const content = await readTrunc(f)
        if (low.includes('人物') || low.includes('角色')) { if (!out.CharPrompt) out.CharPrompt = content; add(f.split('/').pop(), content) }
        else if (low.includes('场景') || low.includes('背景')) { if (!out.ScenePrompt) out.ScenePrompt = content; add(f.split('/').pop(), content) }
        else { if (!out.ExtraPrompt) out.ExtraPrompt = content; add(f.split('/').pop(), content) }
      }
    }
    const sdir = root + '/设定集'
    if (await fexists(sdir)) {
      const parts = []; let total = 0
      for (const f of await listFiles(sdir, '*.md')) {
        const c = await readTrunc(f)
        if (!c) continue
        parts.push('【' + f.split('/').pop() + '】\n' + c)
        total += c.length
        out.Files.push('设定集/' + f.split('/').pop())
        if (total > 20000) break
      }
      if (parts.length) out.Setting = parts.join('\n\n')
    }
    const cover = await readTrunc(root + '/封面/封面提示词.md')
    if (cover) { out.CoverPrompt = cover; out.Files.push('封面/封面提示词.md') }
    return out
  }

  // ── 方案生成系统提示词（对照 NiliX manjuDirectSystem 2026-08-24 最新）──
  function manjuDirectSystem(style) {
    const assetStyle = styleDesc(style).asset
    let s = `你是 MiniMax H3 视频生成模型的导演兼提示词专家。基于给定的小说章节，直接输出完整漫剧渲染方案。

【内容纪律·最高优先】：分镜必须忠实还原小说原文，画面与小说对不上=废镜：
- 台词/旁白必须逐字引用小说原文（原词原句原标点，禁止改写/扩写/翻译/编造）
- 关键剧情事件（冲突/反转/打脸/名场面）必须有对应镜头，禁止跳事件、禁止张冠李戴
- 角色外观/服装/道具逐字从原文提炼，禁止自行增删设定
- 原文没有的台词和事件一律不许出现

【输出 JSON（严格）】：
{
  "episode_title": "集标题",
  "characters": [{"id": "角色名", "role": "正角|反派|功能配角（按剧情阵营判定:主角/女主/正派灵宠/重要正派助攻=正角;主要反派=反派;次要反派/下属/炮灰/龙套=功能配角。【Q版纪律·2026-08-24 用户规则】只有正角才生成 Q 版呆萌形象,反派与功能配角一律不生成、不配使用 Q 版）", "gender": "男/女", "age": "年龄段", "appearance": "完整外观（发型/脸型/五官/气质，逐字从原文提炼，具体到可渲染）", "costume": "完整服装描述", "image_prompt": "给图片模型的英文文生图提示词（【全身立绘·强制】full body, head to toe, 自然 7 头身正常比例, 禁止大头小身/半身/头像/portrait;${assetStyle} 风格;【拟漫化硬规则·2026-08-24 用户规则】semi-realistic stylized illustration of an East Asian/Chinese character, 禁日漫(not a Japanese anime/manga style, avoid japanese-style facial features, japanese anime eyes), 禁真人(not a photorealistic photo of a real person, avoid resembling any real person)——写实风格同样按拟漫化渲染,不输出真人照片;含完整外观/服装/性别强化）", "views": {"front": "英文文生图提示词：正面全身立绘（full body 正面, 头到脚完整, 脸部五官清晰占画面合理比例, ${assetStyle} 风格）", "full": "英文文生图提示词：全身立绘（完整头到脚，正面站姿，自然 7 头身比例，完整服装/鞋履/体态，${assetStyle} 风格）", "side": "英文文生图提示词：侧面全身（侧身 90 度完整头到脚，发型/脸型/服装侧面轮廓清晰，自然比例，${assetStyle} 风格）", "detail": "英文文生图提示词：细节特写（该角色最有辨识度的 1 个细节：饰品/花纹/发饰/疤痕等，大特写构图，${assetStyle} 风格）", "q": "英文文生图提示词：Q版呆萌形象（【Q版纪律·2026-08-24 用户规则】仅 role=正角 才填此项;反派/功能配角此字段留空,不生成 Q 版,其内心独白用写实镜头+画外音渲染。chibi cute style, 圆脸大眼睛短手短脚, 保留该角色标志特征[发型/瞳色/服饰/印记], 呆萌可爱表情, 内心独白/心理活动渲染用 Q 版形象表现, ${assetStyle} 风格）"}}],
  "scenes": [{"id": "场景名（取自原文）", "description": "空间结构/材质/光线/氛围", "image_prompt": "给图片模型的英文文生图提示词（空场景无人物，明亮清晰，${assetStyle} 风格）"}],
  "shots": [
    {
      "shot_id": 1,
      "scene": "场景id",
      "characters": ["角色id(该镜实际登场的全部角色:说话人+同时出镜者,缺一不可;未列出的角色一律不得入画)"],
      "shot_size": "特写/近景/中景/全景/远景",
      "camera": "运镜（类型+幅度+速度，如：缓慢推近）",
      "action": "画面动作描述",
      "style": "该镜渲染风格(2026-08-23 多风格并用:可省略=继承全局风格;需要差异化时给,如写实对话镜=real、奇幻特效镜=real+magical realism、回忆/梦境镜=ink+watercolor、赛博镜=cyberpunk;可 + 组合多个元素,总元素≤4;风格需贴合该镜情绪/内容)",
      "dialogue": "角色:台词（逐字引用小说原文对白，禁止改写/扩写/编造；多句用换行分隔；无对白为空）。【说话人硬约束】"角色:"前缀必须是本镜 characters 中实际开口的角色，谁说的就是谁，禁止张冠李戴；角色说的话一律放 dialogue，禁止混入旁白",
      "narration": "旁白（仅原文叙述性文字/画外音，逐字引用）。【硬约束】旁白禁止包含任何角色的台词——角色说的每句话必须放进 dialogue 并标注对应角色；原文中"XXX说"的对白必须标为该角色 dialogue；无旁白则空；有台词时旁白留空避免重复。【内心独白标记·强制】原文角色内心/心理活动(心想/暗道/嘀咕/盘算等)写 内心·角色名:原文内心内容(渲染时画面用该角色 Q 版呆萌形象+画外音,2026-08-23 用户规则;【Q版纪律·2026-08-24 用户规则】仅 role=正角 的角色用 Q 版,反派/功能配角内心独白不用 Q 版——画面=该角色写实正脸图+画外音),与客观旁白区分",
      "duration": 5
    }
  ],
  "directing": {
    "time": "线性|倒叙|循环|平行切|单时刻切片",
    "pov": "全知|跟随单人|监控·仪器|物的视角|缺席",
    "tempo": "匀速|加速爆发|前紧后松|两次呼吸|全片凝滞",
    "audio": "BGM通铺|对白驱动|音效驱动|环境声|完全静音|声画错位",
    "ending": "空景收|回到首镜|硬切黑|悬而未决|日常化",
    "peak_device": "全片情绪最高点使用的手法(一句话,写手法不写题材,如'摘掉遮脸物+近乎全黑')",
    "climax_pattern": "高潮段镜头组织方式(如'6×特写连打'/'单镜长时凝滞')"
  }
}
【时长硬约束】duration 由台词/动作量决定:中文台词约 4 字/秒(20 字台词≈5 秒;60 字≈12 秒),台词长于时长容纳量必须加时长(4-15)或拆镜;旁白同速折算。台词被截断=废镜。
【防同质化变量表·强制(每集必填)】directing 五维必须逐项选择并**贯彻到分镜**(镜头时长分布/景别/收尾镜/声音设计对应取值):禁止默认组合「线性+全知+匀速+BGM通铺+空景收」(历史最高频重复)。tempo 取值对照时长分布:匀速=各镜等长;加速爆发=逐段加快末段最密;前紧后松=开头密逐渐拉开;全片凝滞=全部取上限时长。ending 取值对照末 1-3 镜:空景收=拉大远景空镜;回到首镜=末镜与首镜同机位同景别;硬切黑=高潮中途切黑;悬而未决=停在一个动作中间;日常化=回落到极普通日常场景。peak_device 写手法本身(摘面具/脱帽/亮武器),不要写题材(防化服/武侠)。
【分镜纪律·强制】:
- shots[].characters 必须列全该镜实际在场的全部角色(说话人+同时出镜者,缺一不可);未列出的角色(长老/弟子/路人/群众)一律不得入画,如需氛围只允许无面部细节的远景虚化
- 【说话人纪律·强制】谁说的就是谁:原文对白按说话角色逐句标入对应 dialogue(前缀"角色:"),严禁把某角色说的话标成他人台词或塞进旁白;旁白只承载原文叙述,绝不含角色话语
- 有台词的说话人必须是该镜的视觉中心主体(景别/机位优先对准说话人),其他登场角色不得遮挡或抢占画面中心
- 同一角色在整集所有镜头中形象必须完全一致(外观/服装逐字复用其 characters 卡,禁止同角色换装/换写法)
【面容独特性纪律·强制(防跨剧撞脸)】:
- 每个角色的 image_prompt 必须给出**独一无二的面容锚点组合**:从 眼型(丹凤眼/桃花眼/狭长眼/圆眼)、眉型(剑眉/柳叶眉/浓眉/细眉)、鼻型(高挺/小巧/鹰钩)、唇形(薄唇/丰唇/唇珠)、脸型(瓜子/方圆/棱角/鹅蛋)、肤色(苍白/小麦/古铜)、气质 中选至少 4 个具体特征,并给 1 个独有印记(痣/疤/耳饰/发色挑染等);**禁止** generic 泛化词(sharp jawline/clear eyes/handsome/young man 单独出现都算,必须搭配具体特征)
- 同剧多角色面容必须**互不相同**(五官/发型/气质可辨认区分);不同剧的相同职位角色(如各剧主角)也必须是不同面容,禁止模板化雷同
- appearance 字段同步给出这些独特特征的中文描述(供提示词外观锁定引用)
【判停清单·模型做不到的六类,换写法不要重抽】(整合 ai-film-skills dialogue-drama 判停清单实测):
- 机械开合(舱盖掀开/抽屉拉出/门开): 拆成「关着的空镜 硬切 开着的空镜」,不写开合过程
- 群体连锁反应(一排人依次回头): 改单人反应 + 画外声补足"一片骚动"
- 走位(走进来/走出画/走到某处): 直接画「已到位」的构图——模型做不出位移,但**原地姿态变化**(起立/坐下/转身/弯腰)可以,别过度保守
- 画内文字: 只允许大号阿拉伯数字(中文/小字必糊),否则画面里干脆不要文字载体(招牌/菜单/路牌/书封)
- 多人互动(A 给 B 戴上某物/交接): 拆成单人镜,用视线缝起来
- 手部纹理级特征(掌纹/指节细节): 改成姿势级特征(握/指/摊开)
【题材真实度判据】(整合 ai-film-skills prompt-craft 实测): 戏剧强度越高越假——火山喷发/冰川崩塌/闪电劈荒原/巨兽正面亮相是 AI 过拟合区,一出必带 AI 味;普通瞬间才真。高危画面优先改拍「痕迹/后果」(如地面炸裂+上方压下的阴影,不正面拍本体);题材选型先问:这个世界里的东西,模型见过真的吗?`
    return s
  }

  // 逐镜 H3 提示词系统提示词（六段式 Ref2VA / 三段式 FL2VA，对照 NiliX 2026-08-24 最新）
  function manjuShotPromptSystem(hasChar, style) {
    const sd = styleDesc(style)
    let sys = '你是 MiniMax H3 视频生成模型的提示词专家。基于给定镜头的分镜信息与角色/场景卡，直出该镜【完整】H3 提示词（英文主体、中文台词/旁白原文）。\n\n输出严格 JSON：{"h3_prompt": "提示词全文"}\n\n'
    sys += '【输出体积硬约束·强制(2026-08-24:此前逐镜输出超长被截断)】:\n'
    sys += '- 六段式必须完整(字段齐全)但每字段精简:subject_definitions 逐项列角色/场景即可(不展开;每个 <Subject> 一行);\n'
    sys += '- detailed_description 控制在 150-220 英文词(构图/动作/运镜/光影/台词逐字;禁止铺陈背景/环境细节);\n'
    sys += '- overall_soundscape 1-2 句、non_diegetic_music 1 句、summary/retention_analysis 各 1 句;\n'
    sys += '- 整个 h3_prompt 控制在 1500 tokens 以内(约 600 英文词),宁可精炼不可超长;\n'
    sys += '- 台词/旁白逐字保留(中文原文),时长=输入 duration。\n\n'
    if (hasChar) {
      sys += `【Ref2VA 六段式(有角色,锁人物),严格此顺序】:
subject_definitions:
<Subject 1> is the character in <Picture 1> and <Picture 2> ... with [完整外观：逐字引用角色卡 appearance（发型/眼睛/疤痕/气质/道具等全部特征逐项覆盖，禁止省略/概括/编造）；服装 costume 全字段；【性别强化】女=feminine facial structure, soft delicate features, long hair（禁男性化），男=masculine jawline, strong brow, broad shoulders（禁女性化）]
[同一角色多视图:该角色有几个参考图就引用几张——<Subject 1> is the character in <Picture 1> (正面/正脸特写), <Picture 2> (全身/侧面/细节), ...;每张视图对应一个 <Picture N> 标签,顺序与 ref_available 该角色的视图顺序一致,全部引用后统一写 with [外观...]]
[多角色镜:每个登场角色一行 <Subject N> is the character in <Picture A> and <Picture B> ...,与参考图顺序一致(角色在前场景在后);画面里谁先出现谁 Subject 号靠前]
[参考图纪律·强制:ref_available 是「角色+视图」的平铺清单,顺序就是参考图传入顺序;<Picture 1..N> 严格对应清单第 1..N 项(同一角色多视图占多个 Picture 编号),Subject 编号与角色一一对应(Subject 1=清单第 1 个角色,依次),禁止调换/跳过/合并视图;清单外的登场角色(本镜参考图不足)写 <Subject N> is [角色名] with 外观描述(不引用任何 Picture),并保持与参考角色不串脸]
[外观锁定·强制:每个角色的外观只允许出现角色卡 appearance+costume 里的特征,且逐项覆盖(发型/眼睛/疤痕/服装/道具缺一不可);禁止 generic 泛化词(ordinary/plain/sturdy/average/young man 等),禁止编造角色卡没有的特征(白发/换装/错误年龄);多角色镜严禁把其他角色的特征写进本角色(谁的特征写谁)]
[拟漫化硬规则·2026-08-24 用户强制:所有角色均为 semi-realistic stylized illustration of an East Asian/Chinese character——参考图已拟漫化,subject_definitions 必须延续此画风;禁止写 photorealistic/realistic photo/real human(真人脸=侵权);禁止写 japanese anime/manga style, japanese-style facial features, japanese anime eyes(禁日漫);角色外形以参考图为准逐字保留,画风恒定拟漫]
[场景编号·强制:场景的 Picture 编号 = 全部角色视图总数 + 1(如 2 角色各 2 视图 → 场景在 <Picture 5>);Subject 编号 = 角色数 + 1]
<Subject N+1> is the [场景名] environment in <Picture M>(M=角色视图总数+1), with [空间结构/材质/光线客观描述，引用场景卡]
[关键道具：<Subject M> is the [道具名] in <Picture M>, with 外观描述；说明与角色互动]

summary:
[reference generation] 本镜任务概述（1-2 句英文，说明目标视频与参考主体关系；任务前缀用官方固定值——参考生成为 reference generation，本管线恒用此值；只引用已定义标签，禁在 summary 引入新标签）

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - 面部/发型/服装与 <Picture 1> 完全一致
[多角色镜:每个角色一行 retention_analysis,全部 fully_preserved]
<Subject N+1> (appears in [Shot 1]): fully_preserved - 场景布局/光线/背景与 <Picture M>(场景编号,同 subject_definitions) 一致
[道具行同理]（标记只用官方固定四值：fully_preserved / partially_preserved / attribute_transfer / weak_reference；【官方规范】retention_analysis 内禁写 (Sx) 说话者 ID）

detailed_description:
${sd.opening}。[实体锁定句：The face, hairstyle, costume of <Subject 1> must remain exactly as in <Picture 1> throughout the shot; the scene layout of <Subject N+1> must match its reference.; 多角色镜加 Each character must keep their own identity from their own reference picture, never swap or blend identities.]
[拟漫化锚句·强制:All characters appear as semi-realistic stylized illustrations, East Asian/Chinese facial features, not photorealistic photos, not Japanese anime style — keep the stylized look consistent with the reference character.]
[Shot 1] [官方建议 150-220 英文词(对话密集优先完整台词时间线):开场构图→主体外观位置→动作状态变化→运镜(类型+幅度+速度,句内自然英语)→光影→台词/旁白→收尾；<Subject N> 标签在主体首次出现处插入,后续镜复用同标签不重定义；情感戏/对话优先近景/中景；末尾散文排除项 no subtitles, no text overlays, no watermark；【亮度护栏·强制】Dark mood is fine for atmosphere, but the subject's face and body must remain clearly visible and well-lit at all times - use a clear light source on the subject (candlelight, moonlight, torch, window light); never render the frame nearly black]

overall_soundscape:
环境底噪/动作音效（1-2 句英文连续段落，禁重复台词）

non_diegetic_music:
纯器乐配乐（1 句：乐器+速度+节奏+动态，禁抽象情绪词；无配乐写 N/A）`
    } else {
      sys += `【FL2VA 三段式（空镜/转场，无主角），严格此顺序】：
第一行对齐指令（两位小数）：How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video.（尾帧锚定时补 Picture 2 (from Shot N) aligns with the S.SS-second mark，S.SS=镜头时长两位小数）
空一行后：
integrated_multimodal_description:
${sd.shot1} + 画面延续首帧（首帧锚定→动作展开→收尾）+ 动作/运镜/光影 + 台词/旁白 <d>[中文]原文</d>（H3 原生配音；时长严格=镜头秒数）+【亮度护栏】Subjects must remain clearly visible and adequately lit - keep readable exposure with visible faces and actions; avoid rendering the frame nearly black

overall_soundscape:
non_diegetic_music:`
    }
    sys += `

【写作规范（官方强制，两种模式都遵守）】：
1. 首镜 [Shot 1] 无时间戳；多切点长镜后续镜 [Shot N] At MM:SS.mmm 严格递增切点时间（官方格式）
2. 说话者 (S1)(S2) 按实际发声顺序分配一次、跨镜复用同一 ID；首次出现给身份描述（年龄/性别/音色/语速/是否画内）；发声者写 <Subject N> (Sx)；【复合说话者】多人齐声/合唱写复合 ID 如 (S1,S2)（官方规范）；从不发声的角色不分配 ID；retention_analysis 中禁写 (Sx)
3. 台词 <d>[中文]原文</d> 逐字保留（原词原标点，句末以 。？！结束，不译不改写，H3 原生对白配音；听不清的片段写 [unclear] 不许猜写）。【说话人硬约束】分镜 dialogue 的每句台词必须由标注的对应角色开口说出：写该角色 <Subject N> (Sx) says: <d>…</d>——谁说的就是谁，禁止把台词安到别的角色头上、禁止把角色台词改写成旁白/画外音
4. 【旁白 = H3 原生画外音，不是 TTS，更不是角色台词】：只有分镜 narration 字段的内容才写 The narrator (S1) says in an off-screen voiceover: <d>[中文]旁白</d> while the on-screen characters' lips remain completely closed（旁白计入 (S1) 说话顺序；旁白与台词不同时出现；【硬约束】分镜 dialogue 里的角色台词禁止写成旁白——必须由对应角色开口，画面中该角色嘴唇在动）
5. 画外音台词也写 says in an off-screen voiceover ... while his/her lips remain completely closed
6. 【跨镜台词连续性（官方标签）】同一句台词跨越镜头切点时，两段接续处各写 <scenetrans> 并声明音频跨切点连续（continues seamlessly across the cut / carries over from the previous shot）；台词被视频结尾截断写 <cutoff>
7. 运镜三要素（类型+幅度+速度）写成句内自然英语（Push In/Pull Out/Pan Left/Pan Right/Truck/Tilt/Pedestal/Arc/Tracking/Static/POV/Roll/Shake；幅度 with small/large amplitude、速度 at slow/fast speed，中等默认省略——官方词表）
8. 排除项/可见文字用英文双引号原文；H3 为 CFG-distilled 无负面词，禁堆叠负面词。输入中的 negative_prompt(用户负面提示词)必须逐概念转译为正面排除句,合并写入 detailed_description 末尾散文(如 bad hands→no distorted hands;text→no text overlays, no watermark;flickering→no flickering frames);语义与既有排除项重复的合并,不重复罗列
9. 画面禁情绪化形容词（只写机位/光影/动作/构图），音效只写现场声，BGM 只写乐器与节奏（禁抽象情绪词，无配乐写 N/A——官方规范）
10. 输入中的 known_issues 是本项目历史高频审片问题:针对每个问题在 detailed_description 写一句正面规避描述(如 面部扭曲→face and hands anatomy must be natural and well-formed;近黑帧→主体带明确光源;水印文字→clean frame, no text overlays),不堆负面词不逐字罗列
11. 【角色纪律·强制】画面中只允许出现该镜 characters 列出的登场角色;未列出的角色(长老/弟子/路人/群众)一律不得入画——如需氛围只能以无面部细节的远景剪影/虚化背景出现,禁止特写/近景/中心构图
12. 【主角中心·强制】说话人/动作主角必须是该镜的视觉中心主体(居中/近景/构图优先),其他登场角色不得抢占画面中心或遮挡主角;主角形象与其参考图完全一致(face, hairstyle, costume)
13. 【跨镜外观锁定·强制】同一角色在本集所有镜头的 subject_definitions 外观描述必须逐字一致(以本集首镜写法为准,后续镜直接复用该写法,禁止每镜重新措辞);detailed_description 中对角色的外观/发型/服装描述也必须与该镜 subject_definitions 一致,禁止出现与 subject_definitions 矛盾的描述
14. 【导演备注·硬规则祈使句·强制】(整合 ai-film-skills 实测)详细描述末尾单独一段写编号祈使句硬规则(不是描述句),模型会遵守:
   1) 切点卡在动作进行中段,禁止动作做完再切;相邻镜头景别必须不同
   2) 场景/光线/服装全程不变,只变机位与姿势;同一镜头内保持单机位连续性
   3) 每个有台词镜头人物嘴唇运动必须与台词同步;无台词镜头 mouth firmly closed
   4) 人物手部/肢体必须有自然动作,禁止呆立定格(治愈留白镜除外:写"停住/保持这个眼神/谁都没动")
   5) 主体必须清晰受光,禁止整帧近黑(暗调氛围可以,脸和身体必须可见)
15. 【状态变化·画"变化之前"·强制】(整合 ai-film-skills dialogue-drama 3.1 实测)同一镜头内部要演出的状态变化(涟漪扩散/裂缝亮起/火焰点燃/印记留下/屏幕亮起),首帧关键帧一律描述「变化之前」的静止状态,变化过程交给动作描述;严禁把变化终点写成首帧(模型只能倒着演回起点)。例:要"石头裂开→橘光涌出",写"暗色石头完好无损 → 裂纹扩散 → 橘光涌出稳住",不要写"石头已裂开发光"
16. 【关系感·物理动作·强制】(整合 ai-film-skills shot-list-prompt ② 实测)角色之间的关系一律写成「距离 + 朝向镜头的物理动作」,禁止抽象关系描述(如"她的头靠在镜头的肩上""两人并肩走远"这类会失败);模型理解"镜头在哪、人朝镜头做什么",不理解"你和她的关系"
17. 【描述零数字·强制】(整合 ai-film-skills chain-consistency ⑤/pitfalls ⑫ 实测)角色/场景描述中禁止出现任何数字(年龄/身高/数量/年份)——会被模型画成画面文字(字幕位);一律改用形容词(如"二十五六岁"→"青年","五十上下"→"年长");需要尺寸写绝对量或占比,禁止"像一枚硬币那么大"类类比(喻体会被画成实物)
18. 【同机位状态镜·接戏规则】(整合 ai-film-skills dialogue-drama 3.1 配套)跨镜同机位状态变化(门开/抽屉/屏幕明灭)用硬切+状态对比描述;接戏靠下一镜动作接切,禁止用首尾同图(last_frame 锁死)钉住终点姿势——首尾同图会把动作整个锁死
19. 【缺席表达·否定句列全·强制】(整合 ai-film-skills prompt-craft 三-C 实测)凡是「某物不在场但留下痕迹」的镜头(空椅子凹陷/无人会议室/只有痕迹),模型必然把那个「某物」画出来——否定句必须逐项列全(「椅子上没有人,画面里没有任何人体、四肢或衣物」「房间空无一人,没有人影,没有身体,只有空椅子」),只写「没有人」无效;写缺席类镜头前自问:那句话里那个不该出现的东西,堵死了吗
20. 【构图指令·权重之争】(整合 ai-film-skills prompt-craft 六 实测)构图指令写了不执行,是权重之争不是措辞问题——指令句被几百字描述稀释,画面塌回默认构图(正面/居中/中景)。两条有效杠杆:①夹句:同一句核心指令在提示词**最前面和最后面各放一遍**,常量夹中间;②画幅裁切:把构图写成物理上塞不下别的东西(「上三分之一只有天,下三分之一只有地,他整个人装在中间那条带子里」),而不是形容它该长什么样。堆形容词/写长写狠无效;水平左右位置(人在画左/画右)提示词基本治不好,需要时改机位/景别设计,不要在措辞里绕
21. 【概念盲区判据·强制】(整合 ai-film-skills prompt-craft 三 实测)某镜头若重渲后错误方向与上次**一致**(不是随机差异),判定为模型概念盲区:禁止继续加词/堆否定,直接改主体或换镜头设计(例:洞螈→洞穴盲鱼;抽象"兽瞳"→具体物种;本体拍不了→拍痕迹/后果);同镜重抽上限后仍不对,改分镜比再抽划算
22. 【人物比例·强制】(2026-08-23 用户反馈大头)角色 image_prompt/detailed_description 人物一律「full body 全身、自然 7 头身比例、禁止大头小身/半身/portrait 头像」;视频人物比例由定妆参考图决定,参考图必须全身
23. 【画面物品清单·强制】(2026-08-23 用户反馈乱入物品)detailed_description 里每个出现的物品写明数量/位置/与主体的关系(「他手里握着缺角镜子,桌面没有其他物品」);禁止笼统场景描述让模型自由发挥补物品;不需要的物品写排除句(no other objects in frame / only XX on the table);同一镜物品数≤3,超过拆镜
24. 【动作流畅·强制】(2026-08-23 用户反馈人物镜头不流畅)每镜**单一主导动作**+小幅+慢速(动作太大/太多 H3 易崩);走位/位移写「已到位」+原地姿态微变;连续动作拆成 2 镜或静态+微动;禁止一镜内多个不相干动作堆叠
25. 【日本人物形象·禁止·强制】(2026-08-23 用户规则:动漫渲染也禁止日本人物形象)无论渲染风格(含 anime/2.5d/动漫),所有人物一律**中式/东方面孔**——detailed_description 人物镜写 East Asian/Chinese facial features(自然眼型,非日漫大眼),正面排除句 avoid japanese-style facial features, japanese anime eyes, big sparkly anime eyes, sharp anime chin;禁止出现日本式脸型/日式动漫大眼/日本风格面容;anime/cartoon **风格词保留**(风格可动漫,脸必须中式东方)
26. 【内心戏 Q 版化·强制·仅正角】(2026-08-23 用户规则 + 2026-08-24 限定:Q 版仅限正角)narration 若为角色内心独白(前缀 内心·角色名,如「内心·阿拾:…」):①若该角色 role=正角(有 Q 版参考图),detailed_description **画面主体=该角色 Q 版呆萌形象**(圆脸/大眼/短手短脚,保留角色标志特征,引用其 Q 版参考图 <Picture>),画外音 The narrator (S1) says in an off-screen voiceover 念内心内容 while lips closed;内心戏镜的 <Subject> 引用该角色 Q 版图而非正脸图;②若该角色 role=反派/功能配角(无 Q 版图),**禁止用 Q 版**——画面主体=该角色写实正脸图+画外音念内心(off-screen voiceover, lips closed);③角色无 role 字段时按有无 Q 版参考图判断:有则 Q 版,无则写实+画外音;非内心客观旁白保持原画面+画外音
27. 【人物微动漫写实·强制】(2026-08-23 用户规则:避免写实人物侵权)写实电影级渲染时,人物形象**微动漫化**——detailed_description 人物写 subtly anime-stylized semi-realistic character, stylized East Asian features(略带动漫风格化:适度圆润/线条化,避免与任何真人肖像高度相似);场景/光影/镜头保持写实电影级(人物微动漫,场景写实);Q 版内心形象不受此限(本就呆萌)
28. 【动物禁人脸·强制】(2026-08-23 用户规则:动物别乱入人脸)动物/萌宠/妖兽/兽类角色一律保持**动物形态**(物种特征:毛皮/鳞甲/兽瞳/喙/爪/尾/角),禁止人脸/人形化/拟人过头;detailed_description 动物镜写 animal form, species-specific features(如 round ink-black blob spirit with golden bead eyes),并明确 no human face;定妆 image_prompt 动物角色加 animal form 约束;穿衣服的拟人化角色(设定明确)除外`
    return sys
  }

  // 逐镜 H3 提示词生成（一次一个镜头；带 ref_available 视图清单 + 内心戏标记 + neg_prompt/known_issues）
  async function genShotPrompt(llm, shot, charMap, sceneMap, style, hasChar, opts) {
    const chars = (shot.characters || []).map((cid) => charMap[cid]).filter(Boolean)
    const scene = sceneMap[shot.scene] || null
    const data = {
      shot_id: shot.shot_id, shot_size: shot.shot_size, camera: shot.camera,
      action: shot.action, dialogue: shot.dialogue, narration: shot.narration, duration: shot.duration,
      characters: chars.map((c) => ({ id: c.id, role: c.role || '', gender: c.gender, age: c.age, appearance: c.appearance, costume: c.costume })),
      scene: scene ? { id: scene.id, description: scene.description } : null,
    }
    // ref_available：该镜登场角色的参考图视图清单（供 <Picture N> 编号与多视图引用）
    const refAvailable = (opts && opts.refAvailable) || []
    if (refAvailable.length) data.ref_available = refAvailable
    // 内心戏标记：narration 含「内心·」→ 命中角色 Q 版优先
    const innerChar = (opts && opts.innerChar) || ''
    if (innerChar) data.inner_char = innerChar
    const sys = manjuShotPromptSystem(hasChar, style)
    const user = JSON.stringify(data, null, 2)
    const r = await llmJSON(llm, sys, user, { maxTokens: 4096, temperature: 0.4 })
    if (!r.ok) return { ok: false, error: r.error }
    const hp = str(r.data.h3_prompt)
    if (!hp) return { ok: false, error: 'LLM 未返回 h3_prompt' }
    return { ok: true, h3_prompt: hp }
  }

  // 方案 JSON 字段归一：兼容 NiliX 的 shot_id / 自研的 shot_id
  function planShotsOf(plan) {
    const arr = (plan && plan.shots) || []
    return arr.map((m, i) => ({
      id: Number(m.shot_id !== undefined ? m.shot_id : m.id) || (i + 1),
      scene: str(m.scene),
      characters: Array.isArray(m.characters) ? m.characters.map(String) : [],
      shot_size: str(m.shot_size), camera: str(m.camera), action: str(m.action),
      style: str(m.style),
      dialogue: str(m.dialogue), narration: str(m.narration),
      duration: num(m.duration, 6),
      h3_prompt: str(m.h3_prompt),
    }))
  }
  function planCharsOf(plan) {
    const arr = (plan && plan.characters) || []
    return arr.map((m) => ({
      id: str(m.id), role: str(m.role), gender: str(m.gender), age: str(m.age),
      appearance: str(m.appearance), costume: str(m.costume), image_prompt: str(m.image_prompt),
      views: (m.views && typeof m.views === 'object') ? m.views : {},
    }))
  }
  function planScenesOf(plan) { const arr = (plan && plan.scenes) || []; return arr.map((m) => ({ id: str(m.id), description: str(m.description), image_prompt: str(m.image_prompt) })) }

  // ── 角色资产辅助（对照 NiliX 2026-08-24：定妆 1024² 固定 / charSeed 稳定种子 / 拟漫化锚）──
  // 拟漫化锚（用户硬规则 2026-08-24）：所有人物图强制半写实拟漫 + 东方/中式面孔，禁日漫禁真人
  const PORTRAIT_ANCHOR = 'semi-realistic stylized illustration of an East Asian/Chinese character, subtly stylized painterly art, not a photorealistic photo of a real person, not a Japanese anime/manga style, avoid japanese-style facial features, avoid japanese anime eyes, avoid resembling any real person'
  // 角色定妆 prompt 统一包装：真人措辞→拟漫 + 锚强制 + 独特面容锚（appearance 逐字引用防撞脸）
  function portraitPrompt(prompt, appearance) {
    let p = String(prompt || '')
    const repl = [
      ['photorealistic', 'semi-realistic stylized'], ['realistic photo', 'stylized illustration'],
      ['real human', 'stylized character'], ['realistic photograph', 'stylized illustration'],
      ['realistic human', 'stylized character'], ['photograph', 'painterly illustration'],
      ['live-action', 'cinematic stylized'],
    ]
    for (const [old, neu] of repl) {
      p = p.split(old).join(neu)
      p = p.split(old.charAt(0).toUpperCase() + old.slice(1)).join(neu)
    }
    if (p.indexOf('not a Japanese anime') < 0) p = p + ', ' + PORTRAIT_ANCHOR
    if (appearance && p.indexOf(appearance) < 0) p = p + ', distinct unique face with: ' + appearance
    return p
  }
  // 稳定随机种子：角色名+视图派生（同角色跨重跑/跨项目稳定；不同角色不同 seed 防雷同面容）
  function charSeed(cid, view) {
    const s = String(cid) + '|' + String(view || '')
    let h = 2166136261
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    return (h >>> 0) % 0x7fffffff
  }
  // 视图资产相对路径（front=正脸特写 _face.png，其余独立视图文件）
  function charViewRel(cid, view) {
    return view === 'front' ? 'characters/' + cid + '_face.png' : 'characters/' + cid + '_' + view + '.png'
  }
  // 视图英文修饰后缀（旧方案无 views 字段时派生）
  function viewSuffix(view) {
    switch (view) {
      case 'full': return 'full body, head to toe, standing pose, complete outfit visible'
      case 'side': return 'side profile, 90 degree side view, face and hairstyle silhouette, body side view'
      case 'detail': return 'extreme close-up on the signature detail (accessory / ornament / scar / hairdo), sharp focus, high detail'
      default: return ''
    }
  }
  // 该镜登场角色的参考图相对路径清单（Picture 顺序；单角色3视图/双角色2视图/三角色1-2视图，总参考≤8+场景）
  function charViewRels(assetsDir, cid, idx, total) {
    let picks
    if (total <= 1) picks = ['front', 'full', 'detail']
    else if (total === 2) picks = ['front', 'full']
    else picks = idx === 0 ? ['front', 'full'] : ['front']
    const out = []
    for (const v of picks) {
      const rel = charViewRel(cid, v)
      if (v === 'front') {
        if (!fs.existsSync(path.resolve(assetsDir.replace(/\//g, path.sep), rel.replace(/\//g, path.sep)))) {
          const main = 'characters/' + cid + '.png'
          if (fs.existsSync(path.resolve(assetsDir.replace(/\//g, path.sep), main.replace(/\//g, path.sep)))) { out.push(main); continue }
          continue
        }
      } else if (!fs.existsSync(path.resolve(assetsDir.replace(/\//g, path.sep), rel.replace(/\//g, path.sep)))) {
        continue
      }
      out.push(rel)
    }
    return out
  }
  // 该镜参考图平铺清单（角色+视图，与 Picture 编号一一对应）：["陈鱼(front)","陈鱼(full)","柳如烟(front)"]
  function shotRefViews(assetsDir, s) {
    const out = []
    const chars = (s.characters || []).slice(0, 3)
    const n = chars.length
    // 内心戏镜：narration 含「内心·」→ Q 版图优先（front + q）
    const innerChars = {}
    if (String(s.narration || '').indexOf('内心·') >= 0) for (const cid of chars) innerChars[cid] = true
    chars.forEach((cid, i) => {
      let rels = charViewRels(assetsDir, cid, i, n)
      if (innerChars[cid]) {
        const qRel = charViewRel(cid, 'q')
        if (fs.existsSync(path.resolve(assetsDir.replace(/\//g, path.sep), qRel.replace(/\//g, path.sep)))) {
          rels = [charViewRel(cid, 'front'), qRel]
        }
      }
      for (const rel of rels) {
        const base = String(rel).split('/').pop().replace(/\.png$/, '')
        let view = base
        if (view === cid || view === cid + '_face') view = 'front'
        else if (view.indexOf(cid + '_') === 0) view = view.slice(cid.length + 1)
        out.push(cid + '(' + view + ')')
      }
    })
    return out
  }

  // 章节抽取（支持 全本/<书名>·全本.md 或 正文/卷X/第N章_*.md）
  async function resolveNovel(project, novelRoot) {
    const base = normPath(str(novelRoot, NOVEL_ROOT) || NOVEL_ROOT)
    let bookRoot = base + '/' + project
    if (await fexists(base)) {
      const r = await pwsh(`Get-ChildItem -LiteralPath '${base}' -Directory | Where-Object { $_.Name -ieq '${project}' } | Select-Object -First 1 -ExpandProperty FullName`)
      const hit = (r.stdout || '').trim()
      if (hit) bookRoot = normPath(hit)
    }
    let novelFile = ''
    const fullDir = bookRoot + '/全本'
    if (await fexists(fullDir)) {
      const files = await listFiles(fullDir, '*.md')
      novelFile = files.find((f) => f.indexOf(project + '·全本') >= 0) || files[0] || ''
    }
    if (!novelFile) {
      const r = await pwsh(`Get-ChildItem -LiteralPath '${bookRoot}/正文' -Recurse -Filter 第*.md -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1 -ExpandProperty FullName`)
      novelFile = normPath((r.stdout || '').trim())
    }
    return { bookRoot, novelFile }
  }

  // 章节文本（chapter 编号 → 单章文本；0/空 → 全文前 N 字）
  async function chapterText(novelFile, chapters) {
    if (!novelFile) return ''
    if (!(await fexists(novelFile))) return ''
    let text = await fread(novelFile)
    if (chapters && chapters !== '0' && chapters !== '') {
      const nums = []
      const m = String(chapters).match(/(\d+)\s*[-~]\s*(\d+)/)
      if (m) { const a = Number(m[1]); const b = Number(m[2]); for (let i = a; i <= b && i < a + 50; i++) nums.push(i) }
      else nums.push(Number(chapters))
      const parts = []
      for (const n of nums) {
        const re = new RegExp('(?:第' + n + '[章节][^\\n]*\\n[\\s\\S]*?)(?=\\n(?:第|#{1,6}\\s*第))', 'g')
        const hits = text.match(re)
        if (hits && hits.length) parts.push(hits[hits.length - 1])
      }
      if (parts.length) text = parts.join('\n\n')
    }
    return text
  }

  // ── 状态与日志 ───────────────────────────────────────────────────────────
  function statePath(workdir) { return workdir + '/run_state.json' }
  function logPath(workdir) { return workdir + '/run.log' }
  async function readState(workdir) {
    try { return JSON.parse(await fread(statePath(workdir))) } catch (e) { return { running: false, stage: '', rc: 0 } }
  }
  async function writeState(workdir, patch) {
    const prev = await readState(workdir)
    const next = Object.assign({}, prev, patch, { updatedAt: Date.now() })
    await fwrite(statePath(workdir), JSON.stringify(next, null, 2))
    return next
  }
  async function appendLog(workdir, line) {
    const p = path.resolve(String(logPath(workdir)).replace(/\//g, path.sep))
    fs.appendFileSync(p, ts() + ' ' + line + '\n', 'utf-8')
  }

  // 停止标记（kill 置位；阶段轮询检查）
  async function stopped(workdir) {
    const st = await readState(workdir)
    return !!(st && st.stopped)
  }
  async function clearStop(workdir) {
    const st = await readState(workdir)
    delete st.stopped
    await writeState(workdir, { stopped: false })
    return st
  }

  // ── M2 方案阶段 ──────────────────────────────────────────────────────────
  async function stagePlan(cfg, cfgPath, project, workdir, lg) {
    const llm = await loadLLM(cfg)
    if (!llm.api_key) return { ok: false, error: '缺少 DeepSeek API Key（config.llm.api_key 或 NiliX server/settings.json）' }
    const style = str(cfg.style, 'real')
    const render = Object.assign(defaultRender(), cfg.render || {})
    const ep = render.episode || '0'
    const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
    const analysisDir = normPath((cfg.paths && cfg.paths.analysis) || workdir + '/analysis')
    await fmkdir(analysisDir)
    const planPath = analysisDir + '/' + epName + '_direct_plan.json'
    const chapter = await chapterText(normPath((cfg.paths && cfg.paths.novel) || ''), render.chapters)
    if (!chapter.trim()) return { ok: false, error: '小说正文为空（' + normPath((cfg.paths && cfg.paths.novel) || '') + '）：先 manju_novel_assemble 生成全本' }
    lg('📖 章节 ' + (render.chapters || '全部') + '（' + chapter.length + ' 字）')
    let sys = manjuDirectSystem(style)
    // 素材注入
    const assets = await scanNovelAssets(normPath((cfg.paths && cfg.paths.novel_dir) || ''))
    if (assets.Files.length) {
      lg('📎 已利用小说素材: ' + assets.Files.join('、'))
      if (assets.Setting) sys += '\n\n【小说设定集·世界观/大纲/创作规范(角色设定/场景设定/剧情线/文风必须贴合,禁止与设定冲突;未知细节以本章原文为准)】\n' + assets.Setting
      if (assets.CharPrompt) sys += '\n\n【小说素材·人物生成提示词(角色 image_prompt 必须贴合此文件的人物描述——外观/服装/气质/记忆点以其为准,再结合章节原文细节;不要照抄整段,提炼为可渲染英文)】\n' + assets.CharPrompt
      if (assets.ScenePrompt) sys += '\n\n【小说素材·场景提示词(场景 image_prompt 必须贴合此文件的场景描述,再结合本章原文)】\n' + assets.ScenePrompt
      if (assets.ExtraPrompt) sys += '\n\n【小说素材·其它提示词(道具/氛围等,如有相关镜头尽量贴合)】\n' + assets.ExtraPrompt
    }
    lg('🤖 大模型直出 人物/场景/分镜...')
    const novelText = chapter.length > 20000 ? chapter.slice(0, 20000) : chapter
    let res = await llmJSON(llm, sys, novelText, { maxTokens: 16384, temperature: 0.4 })
    if (!res.ok || !(res.data && res.data.shots && res.data.shots.length)) {
      lg('  ⚠️ 方案生成无效，追加精简约束重试一次...')
      sys += '\n【精简约束】分镜最多 8 个镜头；每个镜头字段精简但完整；输出必须是合法 JSON，禁止截断。'
      res = await llmJSON(llm, sys, novelText.slice(0, 12000), { maxTokens: 8192, temperature: 0.4 })
      if (!res.ok || !(res.data && res.data.shots && res.data.shots.length)) {
        return { ok: false, error: '方案生成失败(重试后): ' + (res.error || '无镜头') }
      }
    }
    const plan = res.data
    plan.chapters = render.chapters || ''
    plan.episode = epName
    plan.novel_fp = 'mtime-' + Date.now()
    plan.style = style
    await fwrite(planPath, JSON.stringify(plan, null, 2))
    const chars = planCharsOf(plan); const scenes = planScenesOf(plan); const shots = planShotsOf(plan)
    lg('  ✅ ' + chars.length + ' 角色 / ' + scenes.length + ' 场景 / ' + shots.length + ' 镜头')
    // 逐镜 H3 提示词（缺失才生成）
    const charMap = {}; for (const c of chars) charMap[c.id] = c
    const sceneMap = {}; for (const s of scenes) sceneMap[s.id] = s
    const promptsPath = analysisDir + '/' + epName + '_shots_prompts.json'
    let prompts = {}
    try { prompts = JSON.parse(await fread(promptsPath)) } catch (e) { prompts = {} }
    const missing = shots.filter((s) => !prompts[s.id])
    if (missing.length) {
      lg('🤖 逐镜直出完整 H3 提示词（六段式/三段式）...')
      // 参考图资产目录（角色/场景图已生成则注入 ref_available 视图清单）
      const assetsDir = normPath((cfg.paths && cfg.paths.assets) || workdir + '/assets')
      for (let i = 0; i < missing.length; i++) {
        const s = missing[i]
        const hasChar = !!(s.characters && s.characters.length)
        const refAvailable = shotRefViews(assetsDir, s)
        const r = await genShotPrompt(llm, s, charMap, sceneMap, style, hasChar, { refAvailable })
        if (!r.ok) { lg('  ⚠️ 镜头 ' + s.id + ' 提示词失败: ' + r.error); continue }
        prompts[s.id] = r.h3_prompt
        lg('    ✅ 镜头 ' + s.id + ' 提示词就绪' + (refAvailable.length ? '（参考 ' + refAvailable.join('+') + '）' : ''))
      }
      await fwrite(promptsPath, JSON.stringify(prompts, null, 2))
    }
    // 回写 h3_prompt 到 plan（必须写回 plan.shots 原始对象，副本无效）
    const rawShots = (plan.shots || [])
    for (const raw of rawShots) {
      const rid = Number(raw.shot_id !== undefined ? raw.shot_id : raw.id)
      if (prompts[rid]) raw.h3_prompt = prompts[rid]
    }
    await fwrite(planPath, JSON.stringify(plan, null, 2))
    return { ok: true, planPath, episode: epName, characters: chars.length, scenes: scenes.length, shots: shots.length }
  }

  // ── M3 资产阶段（定妆照 1024² 固定 + 五视图 + 场景图；对照 NiliX 2026-08-24）──
  async function stageAssets(cfg, cfgPath, project, workdir, lg, comfy) {
    const render = Object.assign(defaultRender(), cfg.render || {})
    const ep = render.episode || '0'
    const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
    const analysisDir = normPath((cfg.paths && cfg.paths.analysis) || workdir + '/analysis')
    const planPath = analysisDir + '/' + epName + '_direct_plan.json'
    if (!(await fexists(planPath))) return { ok: false, error: '方案不存在：先跑 plan 阶段' }
    const plan = JSON.parse(await fread(planPath))
    const assetsDir = normPath((cfg.paths && cfg.paths.assets) || workdir + '/assets')
    await fmkdir(assetsDir + '/characters')
    await fmkdir(assetsDir + '/scenes')
    const style = str(cfg.style, 'real')
    const neg = str(render.neg_prompt, '')
    const sd = styleDesc(style)
    const isReal = styleHas(style, 'real')
    // 定妆固定尺寸 1024×1024（与项目画幅解耦：同角色跨项目同 prompt 同尺寸 → 形象唯一稳定）
    const PW = 1024, PH = 1024
    const chars = planCharsOf(plan)
    const scenes = planScenesOf(plan)
    const amap = {}
    let made = 0
    // 提交图片工作流并取回（返回本地 dst 路径）
    const genImage = async (wf, what) => {
      const r = await submitImage(comfy, wf, lg)
      if (!r.ok) return { ok: false, error: what + '失败: ' + r.error }
      return { ok: true, path: r.path }
    }
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!c.id) continue
      const cid = safeName(c.id)
      const dst = assetsDir + '/characters/' + cid + '.png'
      // 主图定妆（拟漫化包装：真人措辞→拟漫 + 锚 + 独特面容锚；固定 1024² + charSeed 稳定）
      if (!(await fexists(dst))) {
        lg('🎨 角色定妆照: ' + c.id + ' ...')
        const base = c.image_prompt || ('Cinematic film still, ' + sd.asset + ', character portrait of ' + c.appearance + ' wearing ' + c.costume + ', front-facing, head fully centered, 85mm lens, shallow depth of field, ultra detailed')
        const prompt = portraitPrompt(base, c.appearance)
        const wf = wfZImage(prompt, render, charSeed(c.id, 'main'), PW, PH, 'manju_asset', neg)
        const r = await genImage(wf, '角色 ' + c.id + ' 定妆照')
        if (!r.ok) return r
        await copyBinary(r.path, dst)
        made++
        lg('    ✅ 定妆照: ' + c.id)
      }
      amap[c.id] = 'characters/' + cid + '.png'
      // 五视图：front=正脸特写（从主图裁切）、full/side/detail=基于主图 img2img 换视角保身份、q=Q版（仅正角）
      const comfyInputDir = normPath((cfg.paths && cfg.paths.comfy_input) || COM_INPUT_DEF)
      const viewStrength = { full: 0.82, side: 0.85, detail: 0.7 }
      const viewAnchor = {
        full: 'FULL BODY view, standing full figure from head to toe, entire body visible, three-quarter or front view',
        side: 'SIDE PROFILE view, face turned exactly 90 degrees to the side, strong profile silhouette, nose and chin clearly in profile',
        detail: 'EXTREME CLOSE-UP detail shot, zoomed on the single most distinctive feature (ornament/pattern/hairstyle/scar), large detailed close-up composition',
      }
      const identityAnchor = ', same character as the reference image (identical hair color and hairstyle, identical beard if present, identical facial features, identical costume colors and design)'
      for (const view of ['front', 'full', 'side', 'detail', 'q']) {
        if (view === 'q') {
          // Q 版纪律（2026-08-24 用户规则）：仅 role=正角 生成；反派/功能配角跳过；role 为空默认生成（兼容旧数据）
          const role = str(c.role)
          if (role === '反派' || role === '功能配角') continue
        }
        const vDst = assetsDir + '/' + charViewRel(cid, view)
        if (await fexists(vDst)) continue
        if (view === 'front') {
          // 正脸特写：主图裁切（PIL 兜底无依赖：直接用主图副本作为正脸参考，H3 参考图自动缩放）
          // ★ 用 ffmpeg crop 裁主图中心竖条（接近视频比例的正脸），无 PIL 依赖
          lg('  🔍 正脸特写: ' + c.id + ' ...')
          try {
            const ff = await ffmpegPath()
            const r = await pwsh(`& '${ff}' -y -hide_banner -loglevel error -i '${dst}' -vf "crop=ih*0.62:ih" -frames:v 1 '${vDst}'`, { timeoutMs: 120000 })
            if (r.exitCode === 0 && await fexists(vDst)) { made++; amap[c.id + '_face'] = 'characters/' + cid + '_face.png'; lg('    ✅ 正脸特写: ' + c.id); continue }
          } catch (e) { /* ignore */ }
          // 兜底：主图副本
          await copyBinary(dst, vDst)
          made++; amap[c.id + '_face'] = 'characters/' + cid + '_face.png'
          continue
        }
        // full/side/detail：主图复制进 comfyInput → img2img（Z-Image 保身份换视角）
        const mainRef = 'dir_char_main_' + cid + '.png'
        const mainRefPath = comfyInputDir + '/' + mainRef
        if (!(await fexists(mainRefPath))) await copyBinary(dst, mainRefPath)
        const basePrompt = c.image_prompt || ('Cinematic film still, ' + sd.asset + ', character portrait of ' + c.appearance + ' wearing ' + c.costume)
        const anchored = portraitPrompt(viewAnchor[view] + ', ' + basePrompt + identityAnchor, c.appearance)
        lg('  🎨 角色 ' + c.id + ' ' + view + ' 视图(基于主图 img2img ' + viewStrength[view] + ' + 视角锚/身份锚保持同一人) ...')
        const wf = wfZImage(anchored, render, charSeed(c.id, view), PW, PH, 'manju_asset', neg, mainRef, viewStrength[view])
        const r = await genImage(wf, '角色 ' + c.id + '(' + view + ')')
        if (!r.ok) { lg('  ⚠️ ' + view + ' 视图生成失败(回退主图+正脸): ' + r.error); continue }
        await copyBinary(r.path, vDst)
        made++; amap[c.id + '_' + view] = 'characters/' + cid + '_' + view + '.png'
        lg('    ✅ ' + view + ' 视图: ' + c.id)
      }
    }
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      if (!s.id) continue
      const sid = safeName(s.id)
      const dst = assetsDir + '/scenes/' + sid + '.png'
      if (await fexists(dst)) { lg('  复用场景图: ' + s.id); continue }
      lg('🎨 场景图: ' + s.id + ' ...')
      // 2026-08-24 用户反馈：场景渲染出人物 + 竖比例拼接感 → 强制空场景无人 + 方形 1024²
      const prompt = 'empty scene, no people, ' + (s.image_prompt || ('Cinematic film still, ' + sd.asset + ', empty scene of ' + s.id + ', ' + s.description + ', 85mm lens, ultra detailed, 8k')) + ', no people, no humans, no characters, no figures, no silhouettes'
      const wf = wfZImage(prompt, render, 8000 + i, PW, PH, 'manju_asset', neg)
      const r = await genImage(wf, '场景 ' + s.id)
      if (!r.ok) return r
      await copyBinary(r.path, dst)
      made++
      lg('    ✅ 场景图: ' + s.id)
    }
    // 场景尾帧（可选 fl2va_end_frame：空镜 FL2VA 首尾插值锚点，默认关闭）
    if (render.fl2va_end_frame) {
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i]
        if (!s.id) continue
        const sid = safeName(s.id)
        const endDst = assetsDir + '/scenes/' + sid + '_end.png'
        if (await fexists(endDst)) continue
        const prompt = 'empty scene, no people, ' + (s.image_prompt || ('Cinematic film still, ' + sd.asset + ', empty scene of ' + s.id)) + ', no people, no humans, no characters, no figures, no silhouettes, the same scene at a slightly later moment, subtle motion of elements (leaves drifting, water rippling, light shifting), consistent layout and lighting'
        const wf = wfZImage(prompt, render, 9000 + i, PW, PH, 'manju_asset', neg)
        const r = await genImage(wf, '场景尾帧 ' + s.id)
        if (r.ok) { await copyBinary(r.path, endDst); made++ } else lg('  ⚠️ 场景尾帧生成失败(回退单图 I2VA): ' + r.error)
      }
    }
    try { await fwrite(assetsDir + '/asset_map.json', JSON.stringify(amap, null, 2)) } catch (e) { /* ignore */ }
    lg('  ✅ 资产就绪: ' + chars.length + ' 角色(含五视图) / ' + scenes.length + ' 场景')
    return { ok: true, assetsDir, made }
  }

  // 提交图片工作流并取回（通用）
  async function submitImage(comfy, wf, lg) {
    const r = await comfy.submit(wf)
    if (!r.ok) return r
    const w = await comfy.wait(r.prompt_id, 900000, 5000)
    if (!w.ok) return w
    const entry = await comfy.history(r.prompt_id)
    const media = comfy.outputFiles(entry).find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f.filename))
    const f = await comfy.fetch(media, normPath(COM_OUTPUT_DEF) + '/_manju_tmp')
    return f
  }

  // ── M4 渲染阶段（逐镜 编码→采样→取回；接缝 latent 链）───────────────────
  async function stageRender(cfg, cfgPath, project, workdir, lg, comfy, onlyShots) {
    const render = Object.assign(defaultRender(), cfg.render || {})
    const ep = render.episode || '0'
    const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
    const analysisDir = normPath((cfg.paths && cfg.paths.analysis) || workdir + '/analysis')
    const planPath = analysisDir + '/' + epName + '_direct_plan.json'
    if (!(await fexists(planPath))) return { ok: false, error: '方案不存在：先跑 plan 阶段' }
    const plan = JSON.parse(await fread(planPath))
    const shots = planShotsOf(plan)
    const chars = planCharsOf(plan)
    const scenes = planScenesOf(plan)
    const assetsDir = normPath((cfg.paths && cfg.paths.assets) || workdir + '/assets')
    const clipsEp = normPath((cfg.paths && cfg.paths.clips) || workdir + '/clips') + '/' + epName
    await fmkdir(clipsEp)
    const fps = render.fps || 24
    const seedBase = render.seed || 1688
    const charMap = {}; for (const c of chars) charMap[c.id] = c
    const sceneMap = {}; for (const s of scenes) sceneMap[s.id] = s
    const onlySet = onlyShots ? new Set(String(onlyShots).split(',').map((s) => Number(s.trim())).filter(Boolean)) : null
    const sel = onlySet ? shots.filter((s) => onlySet.has(s.id)) : shots
    if (!sel.length) return { ok: false, error: '没有需要渲染的镜头' }
    const idxOf = {}; shots.forEach((s, i) => { idxOf[s.id] = i + 1 })
    // 条件缓存名（同一条件共享编码；★ 带项目前缀防跨项目串用——2026-08-24 审计）
    const cacheNameFor = (s) => {
      const fp = md5((s.h3_prompt || '') + '|' + (s.characters || []).join(',') + '|' + s.scene + '|' + render.width + 'x' + render.height + '|' + h3Length(s.duration, fps))
      return 'manju_' + safeName(project).slice(0, 12) + '_' + fp.slice(0, 16)
    }
    // 参考图：登场角色多视图（front/full/detail 按角色数预算）+ 场景图
    // ★ ComfyUI LoadImage 只接受相对 input 目录的文件名 → 统一复制到 comfy input 并传文件名
    const comfyInputDir = normPath((cfg.paths && cfg.paths.comfy_input) || COM_INPUT_DEF)
    const assetToComfyInput = async (localPath, tag) => {
      if (!localPath) return ''
      const ext = String(localPath).split('.').pop() || 'png'
      // 用项目名(安全化)+tag 前缀，避免跨项目文件名冲突
      const safeProj = safeName(project).slice(0, 24)
      const fileName = safeProj + '_' + tag + '_' + md5(localPath).slice(0, 10) + '.' + ext
      const dst = comfyInputDir + '/' + fileName
      if (!(await fexists(dst))) await copyBinary(localPath, dst)
      return fileName // 相对文件名（ComfyUI LoadImage 要求）
    }
    // 参考图平铺（角色多视图 + 场景）：Picture 顺序 = ref_available 顺序
    const refFor = async (s) => {
      const refs = []
      const rels = shotRefViews(assetsDir, s)
      for (const rel of rels) {
        const localPath = assetsDir + '/' + rel
        if (await fexists(localPath)) refs.push(await assetToComfyInput(normPath(localPath), 'c' + md5(rel).slice(0, 8)))
      }
      return refs.filter(Boolean)
    }
    const sceneRefFor = async (s) => {
      if (!s.scene) return ''
      const img = assetsDir + '/scenes/' + safeName(s.scene) + '.png'
      if (!(await fexists(img))) return ''
      return assetToComfyInput(normPath(img), 's' + safeName(s.scene))
    }
    const sceneEndRefFor = async (s) => {
      if (!render.fl2va_end_frame || !s.scene) return ''
      const img = assetsDir + '/scenes/' + safeName(s.scene) + '_end.png'
      if (!(await fexists(img))) return ''
      return assetToComfyInput(normPath(img), 'se' + safeName(s.scene))
    }
    const total = sel.length
    let done = 0
    for (const s of sel) {
      if (await stopped(workdir)) return { ok: false, error: '已停止', stopped: true }
      const idx = idxOf[s.id]
      lg('[' + (done + 1) + '/' + total + '] 镜头 ' + s.id + ': [' + s.scene + '] ' + s.shot_size + ' ' + s.camera)
      const dst = clipsEp + '/' + String(idx).padStart(2, '0') + '.mp4'
      if (await fexists(dst)) {
        const fi = await pwsh(`Get-Item -LiteralPath '${dst}' | Select-Object -ExpandProperty Length`)
        if ((fi.stdout || '').trim() === '0') { await fremove(dst); lg('  ⚠️ 0 字节残留删除重渲') }
        else { lg('  跳过（已存在）: ' + dst); done++; await writeState(workdir, { currentStage: 'render', shotCur: done, shotTotal: total }); continue }
      }
      const h3p = s.h3_prompt
      if (!h3p) { lg('  ⚠️ 镜头 ' + s.id + ' 无 h3_prompt，跳过'); continue }
      const hasChar = !!(s.characters && s.characters.length)
      const length = h3Length(s.duration, fps)
      const cacheName = cacheNameFor(s)
      const refs = await refFor(s)
      const sceneRef = await sceneRefFor(s)
      // 1) 条件编码
      lg('  🧬 预编码 ' + s.id + ' (' + length + ' 帧)...')
      const sceneEndRef = await sceneEndRefFor(s)
      const encWf = h3EncWorkflow(render, h3p, render.width, render.height, length, refs.map(normPath), sceneRef, cacheName, hasChar, sceneEndRef)
      const enc = await comfy.submit(encWf)
      if (!enc.ok) { await writeState(workdir, { currentStage: 'render', shotCur: done, shotTotal: total }); return { ok: false, error: '镜头 ' + s.id + ' 编码提交失败: ' + enc.error } }
      const encW = await comfy.wait(enc.prompt_id, 1800000, 8000)
      if (!encW.ok) return { ok: false, error: '镜头 ' + s.id + ' 编码失败: ' + encW.error }
      // 2) 采样渲染（第 1 镜不接缝；后续接缝 prevIdx）
      const prevIdx = idx - 1
      const chained = prevIdx >= 1 && (await fexists(normPath(COM_OUTPUT_DEF) + '/h3_context/clip_' + String(prevIdx).padStart(5, '0') + '.safetensors'))
      const seed = seedBase + (idx - 1)
      lg('  🎬 采样 ' + s.id + ' (seed=' + seed + (chained ? ', 接缝' : '') + ')...')
      const renWf = h3RenderWorkflow(render, seed, render.width, render.height, length, render.steps || 20, cacheName, hasChar, chained, prevIdx, idx)
      const ren = await comfy.submit(renWf)
      if (!ren.ok) { return { ok: false, error: '镜头 ' + s.id + ' 渲染提交失败: ' + ren.error } }
      const renW = await comfy.wait(ren.prompt_id, 5400000, 15000)
      if (!renW.ok) return { ok: false, error: '镜头 ' + s.id + ' 渲染失败: ' + renW.error }
      const entry = await comfy.history(ren.prompt_id)
      const media = comfy.outputVideo(entry)
      const f = await comfy.fetch(media, clipsEp)
      if (!f.ok) return { ok: false, error: '镜头 ' + s.id + ' 取回失败: ' + f.error }
      // 重命名为 NN.mp4；删除 ComfyUI 原始输出残留（manju_*.mp4）
      if (normPath(f.path) !== normPath(dst)) { await copyBinary(f.path, dst); await fremove(f.path) }
      done++
      lg('  ✅ 镜头 ' + s.id + ' 完成 -> ' + dst.split('/').pop())
      await writeState(workdir, { currentStage: 'render', shotCur: done, shotTotal: total })
    }
    // 兜底清理：ComfyUI 原始输出残留（manju_*.mp4）不混入成片/质检
    try {
      for (const f of await listFiles(clipsEp, 'manju_*.mp4')) { await fremove(f); lg('  🧹 清理残留: ' + f.split('/').pop()) }
    } catch (e) { /* ignore */ }
    lg('🎉 渲染完成 -> ' + clipsEp)
    return { ok: true, clipsEp, done }
  }

  // ── M5 质检（ffprobe 机械质检 + 亮度暗像素检测，对照知识库「黑屏兜底」）────
  async function stageQC(cfg, cfgPath, project, workdir, lg) {
    const render = Object.assign(defaultRender(), cfg.render || {})
    const ep = render.episode || '0'
    const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
    const clipsEp = normPath((cfg.paths && cfg.paths.clips) || workdir + '/clips') + '/' + epName
    const skip = new Set(String(render.qc_skip_shots || '').split(',').map((s) => Number(s.trim())).filter(Boolean))
    const files = (await listFiles(clipsEp, '*.mp4')).filter((f) => /\/\d+\.mp4$/.test(f)).sort()
    if (!files.length) return { ok: false, error: '无镜头产物可质检：先跑 render' }
    const report = { episode: epName, passed: true, checks: [] }
    for (const f of files) {
      const n = Number(f.split('/').pop().replace(/^\D+/, '').replace(/\.mp4$/, ''))
      if (skip.has(n)) { report.checks.push({ name: '镜头' + n, passed: true, skipped: true }); continue }
      const v = await ffprobeQC(f)
      report.checks.push({ name: '镜头' + n, passed: v.passed, duration: v.duration, video: v.video, audio: v.audio, darkPct: v.darkPct })
      if (!v.passed) report.passed = false
    }
    lg('✅ 质检完成: ' + (report.passed ? '全部通过' : report.checks.filter((c) => !c.passed).length + ' 个镜头未通过'))
    return { ok: true, report }
  }

  // 机械质检：时长/视频流/音频流 + 亮度暗像素占比（黑屏兜底：暗像素 >50% 判 FAIL）
  async function ffprobeQC(filePath) {
    const ff = await ffprobePath()
    const r = await pwsh(`$ErrorActionPreference='Stop'; & '${ff}' -v error -show_entries stream=codec_type,codec_name -show_entries format=duration -of json '${filePath}'`, { strict: true })
    let pr
    try { pr = JSON.parse(r.stdout) } catch (e) { return { passed: false, error: 'ffprobe 解析失败' } }
    let duration = 0
    try { duration = Number(parseFloat(pr.format && pr.format.duration)) } catch (e) { /* ignore */ }
    let hasVideo = false, hasAudio = false
    for (const s of (pr.streams || [])) { if (s.codec_type === 'video') hasVideo = true; if (s.codec_type === 'audio') hasAudio = true }
    // 亮度检测：signalstats 暗像素占比（Y<16 近黑像素 / 总像素，采样前 60 帧）
    let darkPct = 0
    if (hasVideo && duration > 0) {
      try {
        const r2 = await pwsh(`& '${ff}' -v error -i '${filePath}' -vf "fps=2,signalstats,metadata=print:key=lavfi.signalstats.YMIN" -frames:v 60 -f null NUL`, { timeoutMs: 180000 })
        // 解析 YMIN 输出：近黑帧判定（YMIN <= 16 的比例）
        const lines = (r2.stdout || '').split(/\r?\n/)
        let yminCount = 0, total = 0
        for (const l of lines) {
          const m = l.match(/lavfi\.signalstats\.YMIN=(\d+)/)
          if (m) { total++; if (Number(m[1]) <= 16) yminCount++ }
        }
        if (total > 0) darkPct = Math.round((yminCount / total) * 100)
      } catch (e) { /* 亮度检测失败不阻断 */ }
    }
    const passed = duration > 0 && hasVideo && darkPct <= 50
    return { passed, duration, video: hasVideo, audio: hasAudio, darkPct }
  }
  async function ffprobePath() {
    const p = FFMPEG_DIR_DEF + '/ffprobe.exe'
    if (await fexists(p)) return p
    return 'ffprobe'
  }

  // ── M5 合成（FFmpeg concat + loudnorm + faststart）────────────────────────
  async function stageAssemble(cfg, cfgPath, project, workdir, lg) {
    const render = Object.assign(defaultRender(), cfg.render || {})
    const ep = render.episode || '0'
    const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
    const clipsEp = normPath((cfg.paths && cfg.paths.clips) || workdir + '/clips') + '/' + epName
    const skip = new Set(String(render.qc_skip_shots || '').split(',').map((s) => Number(s.trim())).filter(Boolean))
    // 只合成镜头产物（NN.mp4 数字命名），排除 ComfyUI 原始输出残留（manju_*.mp4）
    const files = (await listFiles(clipsEp, '*.mp4')).filter((f) => /\/\d+\.mp4$/.test(f)).sort().filter((f) => !skip.has(Number(f.split('/').pop().replace(/\.mp4$/, ''))))
    if (!files.length) return { ok: false, error: '无镜头可合成：先跑 render' }
    const out = workdir + '/' + epName + '_成片.mp4'
    const ff = await ffmpegPath()
    // 过滤链：concat + loudnorm
    const ins = files.map((f) => `-i '${f}'`).join(' ')
    let fc = ''
    for (let i = 0; i < files.length; i++) fc += `[${i}:v][${i}:a]`
    fc += `concat=n=${files.length}:v=1:a=1[v][a]`
    if (files.length === 1) {
      // 单镜头直接重编码
      const cmd = `& '${ff}' -y -hide_banner -loglevel error -i '${files[0]}' -af 'aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11' -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart '${out}'`
      const r = await pwsh(cmd, { timeoutMs: 900000 })
      if (r.exitCode !== 0) return { ok: false, error: 'ffmpeg 合成失败: ' + (r.stdout + '\n' + r.stderr).slice(0, 400) }
    } else {
      const cmd = `& '${ff}' -y -hide_banner -loglevel error ${ins} -filter_complex '${fc};[a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]' -map '[v]' -map '[aout]' -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart '${out}'`
      const r = await pwsh(cmd, { timeoutMs: 1800000 })
      if (r.exitCode !== 0) return { ok: false, error: 'ffmpeg 合成失败: ' + (r.stdout + '\n' + r.stderr).slice(0, 400) }
    }
    lg('🎬 成片: ' + out)
    return { ok: true, output: out, clips: files.length }
  }
  async function ffmpegPath() {
    const p = FFMPEG_DIR_DEF + '/ffmpeg.exe'
    if (await fexists(p)) return p
    return 'ffmpeg'
  }

  // ── 阶段分发（run 主入口，异步后台执行）──────────────────────────────────
  const STAGE_ORDER = ['plan', 'assets', 'encode', 'render', 'qc', 'assemble']
  async function runStages(cfg, cfgPath, project, workdir, phases, opts, lg) {
    const comfy = comfyClient((cfg.render && cfg.render.comfy_url) || COM_URL_DEF)
    const only = str(opts.only, '')
    const fresh = !!opts.fresh
    for (const ph of phases) {
      if (await stopped(workdir)) { lg('⏹ 已停止'); return { ok: false, stopped: true } }
      await writeState(workdir, { running: true, stage: ph, currentStage: ph, stageIdx: STAGE_ORDER.indexOf(ph) + 1, shotCur: 0, shotTotal: 0, rc: 0 })
      lg('┌── 阶段 ' + ph + ' ──┐')
      let res
      switch (ph) {
        case 'plan': res = await stagePlan(cfg, cfgPath, project, workdir, lg); break
        case 'assets': res = await stageAssets(cfg, cfgPath, project, workdir, lg, comfy); break
        case 'encode': res = { ok: true, note: 'encode 已并入 render 逐镜（Qwen3-VL 条件缓存按镜头惰性生成）' }; break
        case 'render': res = await stageRender(cfg, cfgPath, project, workdir, lg, comfy, only); break
        case 'qc': res = await stageQC(cfg, cfgPath, project, workdir, lg); break
        case 'assemble': res = await stageAssemble(cfg, cfgPath, project, workdir, lg); break
        default: res = { ok: false, error: '未知阶段: ' + ph }
      }
      if (!res.ok) {
        await writeState(workdir, { running: false, rc: 1, error: res.error, stopped: res.stopped ? true : undefined })
        lg('❌ 阶段 ' + ph + ' 失败: ' + res.error)
        return res
      }
    }
    await writeState(workdir, { running: false, rc: 0, stage: '', currentStage: 'done', done: true })
    lg('🎉 全部阶段完成')
    return { ok: true }
  }

  // 阶段解析：phase + episode → 实际执行链
  function phasesOf(phase) {
    const p = str(phase, 'all')
    if (p === 'all') return STAGE_ORDER
    if (STAGE_ORDER.includes(p)) return [p]
    return []
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 对外 API（供 index.js 工具层调用）
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    // 常量/工具暴露
    NOVEL_ROOT, MANJU_SELF, MANJU_LEGACY, NILIX_SERVER_CFG, COM_INPUT_DEF, COM_OUTPUT_DEF, COM_URL_DEF,
    H3_STYLES, defaultRender, h3Length, align32, h3ComplianceOf, styleDesc, styleHas, safeName,
    str, num, has, md5, normPath, fullPath, ts,
    pwsh, httpGet, httpPost, fexists, fread, fmkdir, fcopy, fwrite, fremove, listDir, listFiles, copyBinary,
    resolveManjuRoot, cfgPathOf, projectDirOf, readCfg, loadLLM, comfyDirs, comfyClient,
    resolveNovel, chapterText, scanNovelAssets,
    manjuDirectSystem, manjuShotPromptSystem, genShotPrompt, planShotsOf, planCharsOf, planScenesOf,
    portraitPrompt, charSeed, charViewRel, viewSuffix, charViewRels, shotRefViews,
    statePath, logPath, readState, writeState, appendLog, stopped, clearStop,
    stagePlan, stageAssets, stageRender, stageQC, stageAssemble, runStages, phasesOf,
    extractJSON, llmChat, llmJSON,
  }
}

module.exports = { createEngine }
