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

  // Z-Image 文生图（场景图/写实定妆照，8 步 turbo）
  function wfZImage(prompt, R, seed, w, h, prefix, neg) {
    const wf = {}
    const mid = wfAdd(wf, 'UNETLoader', { unet_name: str(R.z_image_unet), weight_dtype: 'default' })
    const clipID = wfAdd(wf, 'CLIPLoader', { clip_name: str(R.z_image_clip), type: 'qwen_image' })
    const vaeID = wfAdd(wf, 'VAELoader', { vae_name: str(R.z_image_vae) })
    const pos = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(clipID), text: prompt })
    const negID = wfAdd(wf, 'CLIPTextEncode', { clip: refOf(clipID), text: neg || '' })
    const latent = wfAdd(wf, 'EmptySD3LatentImage', { width: w, height: h, batch_size: 1 })
    const samp = wfAdd(wf, 'KSampler', { model: refOf(mid), positive: refOf(pos), negative: refOf(negID), latent_image: refOf(latent), seed, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 })
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
  function h3EncWorkflow(R, prompt, w, h, length, charRefs, sceneRef, cacheName, hasChar) {
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
      if (refs.length) inputs.ref_images = refs
      condID = wfAdd(wf, 'MiniMaxH3ReferenceToVideo', inputs)
    } else {
      const inputs = { clip: refOf(clip), vae: refOf(vae), prompt, width: w, height: h, length }
      if (sceneRef) inputs.first_frame = refOf(wfAdd(wf, 'LoadImage', { image: sceneRef }))
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

  // ── 方案生成系统提示词（对照 NiliX manjuDirectSystem）───────────────────
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
  "characters": [{"id": "角色名", "gender": "男/女", "age": "年龄段", "appearance": "完整外观（发型/脸型/五官/气质，逐字从原文提炼，具体到可渲染）", "costume": "完整服装描述", "image_prompt": "给图片模型的英文文生图提示词（半身立绘，${assetStyle} 风格，正面正脸、头部完整居中（含发顶到下巴），含完整外观/服装/性别强化）"}],
  "scenes": [{"id": "场景名（取自原文）", "description": "空间结构/材质/光线/氛围", "image_prompt": "给图片模型的英文文生图提示词（空场景无人物，明亮清晰，${assetStyle} 风格）"}],
  "shots": [
    {
      "shot_id": 1,
      "scene": "场景id",
      "characters": ["角色id(该镜实际登场的全部角色:说话人+同时出镜者,缺一不可;未列出的角色一律不得入画)"],
      "shot_size": "特写/近景/中景/全景/远景",
      "camera": "运镜（类型+幅度+速度，如：缓慢推近）",
      "action": "画面动作描述",
      "dialogue": "角色:台词（逐字引用小说原文对白，禁止改写/扩写/编造；多句用换行分隔；无对白为空）。【说话人硬约束】"角色:"前缀必须是本镜 characters 中实际开口的角色，谁说的就是谁，禁止张冠李戴；角色说的话一律放 dialogue，禁止混入旁白",
      "narration": "旁白（仅原文叙述性文字/画外音，逐字引用）。【硬约束】旁白禁止包含任何角色的台词——角色说的每句话必须放进 dialogue 并标注对应角色；原文中"XXX说"的对白必须标为该角色 dialogue；无旁白则空；有台词时旁白留空避免重复",
      "duration": 5
    }
  ]
}
【时长硬约束】duration 由台词/动作量决定:中文台词约 4 字/秒(20 字台词≈5 秒;60 字≈12 秒),台词长于时长容纳量必须加时长(4-15)或拆镜;旁白同速折算。台词被截断=废镜。
【分镜纪律·强制】:
- shots[].characters 必须列全该镜实际在场的全部角色(说话人+同时出镜者,缺一不可);未列出的角色(长老/弟子/路人/群众)一律不得入画,如需氛围只允许无面部细节的远景虚化
- 【说话人纪律·强制】谁说的就是谁:原文对白按说话角色逐句标入对应 dialogue(前缀"角色:"),严禁把某角色说的话标成他人台词或塞进旁白;旁白只承载原文叙述,绝不含角色话语
- 有台词的说话人必须是该镜的视觉中心主体(景别/机位优先对准说话人),其他登场角色不得遮挡或抢占画面中心
- 同一角色在整集所有镜头中形象必须完全一致(外观/服装逐字复用其 characters 卡,禁止同角色换装/换写法)`
    return s
  }

  // 逐镜 H3 提示词系统提示词（六段式 Ref2VA / 三段式 FL2VA，对照 NiliX）
  function manjuShotPromptSystem(hasChar, style) {
    const sd = styleDesc(style)
    let sys = '你是 MiniMax H3 视频生成模型的提示词专家。基于给定镜头的分镜信息与角色/场景卡，直出该镜【完整】H3 提示词（英文主体、中文台词/旁白原文）。\n\n输出严格 JSON：{"h3_prompt": "提示词全文"}\n\n'
    if (hasChar) {
      sys += `【Ref2VA 六段式(有角色,锁人物),严格此顺序】:
subject_definitions:
<Subject 1> is the character in <Picture 1> with [完整外观：逐字引用角色卡 appearance（发型/眼睛/疤痕/气质/道具等全部特征逐项覆盖，禁止省略/概括/编造）；服装 costume 全字段；【性别强化】女=feminine facial structure, soft delicate features, long hair（禁男性化），男=masculine jawline, strong brow, broad shoulders（禁女性化）]
[多角色镜:每个登场角色一行 <Subject N> is the character in <Picture N>…,与参考图顺序一致(角色在前场景在后);画面里谁先出现谁 Subject 号靠前]
[参考图纪律·强制:ref_available 名单的顺序就是参考图传入顺序;<Picture 1..N> 严格对应名单第 1..N 个角色,Subject 编号与之一一对应(Subject 1=名单第 1 个角色,依次),禁止调换/跳过/合并;名单外的登场角色(本镜参考图不足)写 <Subject N> is [角色名] with 外观描述(不引用任何 Picture),并保持与参考角色不串脸]
[外观锁定·强制:每个角色的外观只允许出现角色卡 appearance+costume 里的特征,且逐项覆盖(发型/眼睛/疤痕/服装/道具缺一不可);禁止 generic 泛化词(ordinary/plain/sturdy/average/young man 等),禁止编造角色卡没有的特征(白发/换装/错误年龄);多角色镜严禁把其他角色的特征写进本角色(谁的特征写谁)]
<Subject N+1> is the [场景名] environment in <Picture N+1>, with [空间结构/材质/光线客观描述，引用场景卡]
[关键道具：<Subject M> is the [道具名] in <Picture M>, with 外观描述；说明与角色互动]

summary:
[reference generation] 本镜任务概述（1-2 句英文，说明目标视频与参考主体关系；任务前缀用官方固定值——参考生成为 reference generation，本管线恒用此值；只引用已定义标签，禁在 summary 引入新标签）

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - 面部/发型/服装与 <Picture 1> 完全一致
[多角色镜:每个角色一行 retention_analysis,全部 fully_preserved]
<Subject N+1> (appears in [Shot 1]): fully_preserved - 场景布局/光线/背景与 <Picture N+1> 一致
[道具行同理]（标记只用官方固定四值：fully_preserved / partially_preserved / attribute_transfer / weak_reference；【官方规范】retention_analysis 内禁写 (Sx) 说话者 ID）

detailed_description:
${sd.opening}。[实体锁定句：The face, hairstyle, costume of <Subject 1> must remain exactly as in <Picture 1> throughout the shot; the scene layout of <Subject N+1> must match its reference.; 多角色镜加 Each character must keep their own identity from their own reference picture, never swap or blend identities.]
[Shot 1] [官方建议 350-500 英文词(对话密集优先完整台词时间线):开场构图→主体外观位置→动作状态变化→运镜(类型+幅度+速度,句内自然英语)→光影→台词/旁白→收尾；<Subject N> 标签在主体首次出现处插入,后续镜复用同标签不重定义；情感戏/对话优先近景/中景；末尾散文排除项 no subtitles, no text overlays, no watermark；【亮度护栏·强制】Dark mood is fine for atmosphere, but the subject's face and body must remain clearly visible and well-lit at all times - use a clear light source on the subject (candlelight, moonlight, torch, window light); never render the frame nearly black]

overall_soundscape:
环境底噪/动作音效（1-4 句英文连续段落，禁重复台词）

non_diegetic_music:
纯器乐配乐（1-3 句：乐器+速度+节奏+动态，禁抽象情绪词；无配乐写 N/A）`
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
8. 排除项/可见文字用英文双引号原文；H3 为 CFG-distilled 无负面词，禁堆叠负面词
9. 画面禁情绪化形容词（只写机位/光影/动作/构图），音效只写现场声，BGM 只写乐器与节奏（禁抽象情绪词，无配乐写 N/A——官方规范）
10. 【角色纪律·强制】画面中只允许出现该镜 characters 列出的登场角色;未列出的角色(长老/弟子/路人/群众)一律不得入画——如需氛围只能以无面部细节的远景剪影/虚化背景出现,禁止特写/近景/中心构图
11. 【主角中心·强制】说话人/动作主角必须是该镜的视觉中心主体(居中/近景/构图优先),其他登场角色不得抢占画面中心或遮挡主角;主角形象与其参考图完全一致(face, hairstyle, costume)
12. 【跨镜外观锁定·强制】同一角色在本集所有镜头的 subject_definitions 外观描述必须逐字一致(以本集首镜写法为准,后续镜直接复用该写法,禁止每镜重新措辞);detailed_description 中对角色的外观/发型/服装描述也必须与该镜 subject_definitions 一致,禁止出现与 subject_definitions 矛盾的描述`
    return sys
  }

  // 逐镜 H3 提示词生成（一次一个镜头）
  async function genShotPrompt(llm, shot, charMap, sceneMap, style, hasChar) {
    const chars = (shot.characters || []).map((cid) => charMap[cid]).filter(Boolean)
    const scene = sceneMap[shot.scene] || null
    const data = {
      shot_id: shot.shot_id, shot_size: shot.shot_size, camera: shot.camera,
      action: shot.action, dialogue: shot.dialogue, narration: shot.narration, duration: shot.duration,
      characters: chars.map((c) => ({ id: c.id, gender: c.gender, age: c.age, appearance: c.appearance, costume: c.costume })),
      scene: scene ? { id: scene.id, description: scene.description } : null,
    }
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
      dialogue: str(m.dialogue), narration: str(m.narration),
      duration: num(m.duration, 6),
      h3_prompt: str(m.h3_prompt),
    }))
  }
  function planCharsOf(plan) { const arr = (plan && plan.characters) || []; return arr.map((m) => ({ id: str(m.id), gender: str(m.gender), age: str(m.age), appearance: str(m.appearance), costume: str(m.costume), image_prompt: str(m.image_prompt) })) }
  function planScenesOf(plan) { const arr = (plan && plan.scenes) || []; return arr.map((m) => ({ id: str(m.id), description: str(m.description), image_prompt: str(m.image_prompt) })) }

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
      for (let i = 0; i < missing.length; i++) {
        const s = missing[i]
        const hasChar = !!(s.characters && s.characters.length)
        const r = await genShotPrompt(llm, s, charMap, sceneMap, style, hasChar)
        if (!r.ok) { lg('  ⚠️ 镜头 ' + s.id + ' 提示词失败: ' + r.error); continue }
        prompts[s.id] = r.h3_prompt
        lg('    ✅ 镜头 ' + s.id + ' 提示词就绪')
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

  // ── M3 资产阶段（定妆照 + 场景图，Z-Image）───────────────────────────────
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
    const chars = planCharsOf(plan)
    const scenes = planScenesOf(plan)
    let made = 0
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!c.id) continue
      const dst = assetsDir + '/characters/' + safeName(c.id) + '.png'
      if (await fexists(dst)) { lg('  复用定妆照: ' + c.id); continue }
      lg('🎨 角色定妆照: ' + c.id + ' ...')
      const prompt = c.image_prompt || ('Cinematic film still, ' + sd.asset + ', character portrait of ' + c.appearance + ' wearing ' + c.costume + ', front-facing, head fully centered, 85mm lens, shallow depth of field, ultra detailed')
      const wf = isReal
        ? wfZImage(prompt, render, 7000 + i, 768, 1024, 'manju_asset', neg)
        : wfSDXL(prompt, str(render.char_models[c.gender] || render.animagine_ckpt), 7000 + i, 768, 1024, 'manju_asset', neg)
      const r = await submitImage(comfy, wf, lg)
      if (!r.ok) return { ok: false, error: '角色 ' + c.id + ' 定妆照失败: ' + r.error }
      await copyBinary(r.path, dst)
      made++
      lg('    ✅ 定妆照: ' + c.id)
    }
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      if (!s.id) continue
      const dst = assetsDir + '/scenes/' + safeName(s.id) + '.png'
      if (await fexists(dst)) { lg('  复用场景图: ' + s.id); continue }
      lg('🎨 场景图: ' + s.id + ' ...')
      const prompt = s.image_prompt || ('Cinematic film still, ' + sd.asset + ', empty scene of ' + s.id + ', ' + s.description + ', 85mm lens, ultra detailed, 8k')
      const wf = wfZImage(prompt, render, 8000 + i, render.width || 768, render.height || 1344, 'manju_asset', neg)
      const r = await submitImage(comfy, wf, lg)
      if (!r.ok) return { ok: false, error: '场景 ' + s.id + ' 失败: ' + r.error }
      await copyBinary(r.path, dst)
      made++
      lg('    ✅ 场景图: ' + s.id)
    }
    lg('  ✅ 资产就绪: ' + chars.length + ' 角色 / ' + scenes.length + ' 场景')
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
    // 条件缓存名（同一条件共享编码）
    const cacheNameFor = (s) => {
      const fp = md5((s.h3_prompt || '') + '|' + (s.characters || []).join(',') + '|' + s.scene + '|' + render.width + 'x' + render.height + '|' + h3Length(s.duration, fps))
      return 'manju_' + fp.slice(0, 16)
    }
    // 参考图：登场角色正脸优先（characters/<id>.png）+ 场景图
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
    const refFor = async (s) => {
      const refs = []
      for (const cid of (s.characters || [])) {
        const img = assetsDir + '/characters/' + safeName(cid) + '.png'
        if (await fexists(img)) refs.push(await assetToComfyInput(normPath(img), 'c' + safeName(cid)))
      }
      return refs.filter(Boolean)
    }
    const sceneRefFor = async (s) => {
      if (!s.scene) return ''
      const img = assetsDir + '/scenes/' + safeName(s.scene) + '.png'
      if (!(await fexists(img))) return ''
      return assetToComfyInput(normPath(img), 's' + safeName(s.scene))
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
      const encWf = h3EncWorkflow(render, h3p, render.width, render.height, length, refs.map(normPath), sceneRef, cacheName, hasChar)
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

  // ── M5 质检（ffprobe 机械质检）───────────────────────────────────────────
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
      report.checks.push({ name: '镜头' + n, passed: v.passed, duration: v.duration, video: v.video, audio: v.audio })
      if (!v.passed) report.passed = false
    }
    lg('✅ 质检完成: ' + (report.passed ? '全部通过' : report.checks.filter((c) => !c.passed).length + ' 个镜头未通过'))
    return { ok: true, report }
  }

  async function ffprobeQC(filePath) {
    const ff = await ffprobePath()
    const r = await pwsh(`$ErrorActionPreference='Stop'; & '${ff}' -v error -show_entries stream=codec_type,codec_name -show_entries format=duration -of json '${filePath}'`, { strict: true })
    let pr
    try { pr = JSON.parse(r.stdout) } catch (e) { return { passed: false, error: 'ffprobe 解析失败' } }
    let duration = 0
    try { duration = Number(parseFloat(pr.format && pr.format.duration)) } catch (e) { /* ignore */ }
    let hasVideo = false, hasAudio = false
    for (const s of (pr.streams || [])) { if (s.codec_type === 'video') hasVideo = true; if (s.codec_type === 'audio') hasAudio = true }
    const passed = duration > 0 && hasVideo
    return { passed, duration, video: hasVideo, audio: hasAudio }
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
    statePath, logPath, readState, writeState, appendLog, stopped, clearStop,
    stagePlan, stageAssets, stageRender, stageQC, stageAssemble, runStages, phasesOf,
    extractJSON, llmChat, llmJSON,
  }
}

module.exports = { createEngine }
