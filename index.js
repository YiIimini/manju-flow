// ═══════════════════════════════════════════════════════════════════════════
// 漫剧一条龙 Manju Flow — 正式插件包 Host 半边（重启持久）
// 唯一实现来源：本包。preset 只保留人格/技能，不再注册工具；UI 面板（client.js）
// 通过 manjuConsole Remote 服务复用本文件业务实现，无重复逻辑。
//
// ★ 自研引擎（engine.js）：M2 渲染域全部本地化，直连 ComfyUI(8190) + DeepSeek +
//   FFmpeg/ffprobe，零 NiliX(8787) 依赖。渲染工具不再调用 /api/manju/*。
//
// 架构（按功能模块化，便于维护）：
//   M0 基建    http 双通道(web.fetch + pwsh 兜底) / shell / fs / token / python / 参数映射表
//   M1 小说域  7 工具：scaffold dispatch qa cover materials assemble web
//   M2 渲染域  13 工具：config health run status post kill comfy gacha qc agent notify manage script jobs
//   M3 编排域  1 工具：pipeline_plan
//   M4 面板域  manjuConsole Remote 服务（14 方法）+ typert contribution：Client 经
//              ctx.remote.manjuConsole.* 调用，host typert 注册后由 gateway 路由
//
// 重构要点（对比历史版本）：
//   - 统一工具工厂 tool()：output/render/wrap/参数校验一次定义
//   - 参数映射表 CAMEL_MAP / INT_MAP：camelCase 工具参数 → snake_case NiliX 字段集中映射
//   - 单一 HTTP 层：getJSON/postJSON/postMultipart 收口所有 NiliX 调用
//   - 错误折叠统一 wrap()：所有工具返回 {ok,...} 纯 JSON
//   - H3 合规内建：32 倍数对齐 / 面积与风格提示 / h3Compliance 摘要
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// 常量与域参数（环境变量优先，兼容本机既有配置）
// ─────────────────────────────────────────────────────────────────────────────
const userProfile = process.env.DSH_USERPROFILE || process.env.USERPROFILE || 'C:/Users/Administrator'
const SKILL = process.env.NOVEL_SKILL || (userProfile + '/.agents/skills/shuangwen-novel')
const NILIX = 'http://127.0.0.1:8787'
const NOVEL_ROOT = process.env.NOVEL_ROOT || 'C:/Mi/Ai/WorkBench/novel'
const MANJU_SELF = process.env.MANJU_ROOT || 'C:/Mi/Ai/WorkBench/NiliX/manju'
const MANJU_LEGACY = 'C:/Mi/Ai/WorkBench/manju'
const NILIX_SERVER_CFG = process.env.NILIX_SERVER_CFG || 'C:/Mi/Ai/WorkBench/NiliX/server/settings.json'
const COM_INPUT_DEF = (process.env.COMFY_INPUT || (userProfile + '/AppData/Local/Comfy-Desktop/ComfyUI-Shared/input')).replace(/\\/g, '/')
const COM_OUTPUT_DEF = (process.env.COMFY_OUTPUT || 'C:/Mi/Ai/WorkBench/NiliX/ComfyUI/output').replace(/\\/g, '/')
const FFMPEG_DIR_DEF = process.env.FFMPEG_DIR || (userProfile + '/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin')
const COM_URL_DEF = process.env.COMFY_URL || 'http://127.0.0.1:8190'
const H3_STYLES = ['2.5d', 'real', '3d', 'anime', 'handdrawn', 'papercraft', 'clay', 'ink']
const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五']
const cnNum = (n) => CN_NUM[n] || String(n)
// 渲染字符串参数：工具 camelCase → NiliX snake_case（render-save / config 共用）
const STR_MAP = [
  ['comfyUrl', 'comfy_url'], ['negPrompt', 'neg_prompt'], ['unetFl2va', 'unet_fl2va'], ['unetRef2va', 'unet_ref2va'],
  ['clip', 'clip'], ['vaeVideo', 'vae_video'], ['vaeAudio', 'vae_audio'], ['zImageUnet', 'z_image_unet'],
  ['zImageClip', 'z_image_clip'], ['zImageVae', 'z_image_vae'], ['turboLora', 'turbo_lora'], ['turboLoraR2v', 'turbo_lora_r2v'],
  ['animagineCkpt', 'animagine_ckpt'], ['chapters', 'chapters'], ['episode', 'episode'], ['shots', 'shots'],
  ['resTier', 'res_tier'], ['transition', 'transition'], ['bgm', 'bgm'], ['seedPolicy', 'seed_policy'],
]
// 渲染整型参数映射（render-save 用）
const INT_MAP = [
  ['width', 'width'], ['height', 'height'], ['fps', 'fps'], ['steps', 'steps'], ['turboSteps', 'turbo_steps'],
  ['minShotSeconds', 'min_shot_seconds'], ['maxShotSeconds', 'max_shot_seconds'], ['shotsPerTake', 'shots_per_take'],
]

// ★ 自研引擎（零 NiliX 依赖）：ComfyUI 直连 + DeepSeek + FFmpeg/ffprobe 本地
const { createEngine } = require('./engine')
const DEEPSEEK_DEF = { base_url: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.4, max_tokens: 8192, request_timeout: 300 }
const nodePath = require('node:path')
// 路径归一（与 engine.js 同逻辑）
const normPath = (p) => String(p || '').replace(/\\/g, '/')

module.exports = {
  name: 'manju-flow',
  inject: ['shell', 'web', 'fs', 'tools', 'typert'],
  apply(ctx) {
    const log = (...a) => console.log('[manju-flow]', ...a)

    // ═══════════════════════════════════════════════════════════════════════
    // M0 基建
    // ═══════════════════════════════════════════════════════════════════════

    const FULL_POLICY = { mode: 'danger-full-access', workspaceRoot: 'C:/Mi/Ai/WorkBench' }

    // 执行 PowerShell（strict=非零退出抛错让失败可见）
    async function pwsh(lines, opts) {
      const shell = ctx.get('shell')
      if (!shell) throw new Error('shell 服务不可用')
      const req = { command: Array.isArray(lines) ? lines.join('\n') : lines, sandboxPolicy: FULL_POLICY }
      if (opts && opts.timeoutMs) req.timeoutMs = opts.timeoutMs
      if (opts && opts.stdoutMaxBytes) req.stdoutMaxBytes = opts.stdoutMaxBytes
      let spec = req
      try {
        if (typeof shell.resolve === 'function') { spec = shell.resolve(req); spec.sandboxPolicy = FULL_POLICY }
      } catch (e) { /* 保持原始请求 */ }
      const res = await shell.run(spec)
      const stdout = (res.stdout && res.stdout.text) || ''
      const stderr = (res.stderr && res.stderr.text) || ''
      const denied = !!(res.sandbox && res.sandbox.denied)
      if (opts && opts.strict && (res.exitCode !== 0 || denied)) {
        throw new Error('pwsh exit=' + res.exitCode + (denied ? ' [denied]' : '') + ': ' + (stdout + '\n' + stderr).trim().slice(0, 2000))
      }
      return { exitCode: res.exitCode, stdout, stderr, denied }
    }

    // GET JSON（web.fetch 优先，pwsh 兜底；8MB 捕获上限防大响应截断）
    async function getJSON(path) {
      const web = ctx.get('web')
      if (web && typeof web.fetch === 'function') {
        try {
          const res = await web.fetch({ url: NILIX + path })
          const content = res && res.body && typeof res.body.content === 'string' ? res.body.content : ''
          try { return { status: res.statusCode, data: JSON.parse(content) } } catch (e) { return { status: res.statusCode, raw: content } }
        } catch (e) { log('web.fetch failed, fallback pwsh:', e && e.message) }
      }
      const r = await pwsh(`try { $r = Invoke-RestMethod -Uri '${NILIX}${path}' -Method Get -TimeoutSec 60; $r | ConvertTo-Json -Depth 16 } catch { Write-Output ('__NILIX_ERR__' + $_.Exception.Message) }`, { timeoutMs: 90000, stdoutMaxBytes: 8 * 1024 * 1024 })
      const out = (r.stdout || '').trim()
      if (out.startsWith('__NILIX_ERR__')) return { status: 0, error: out.slice(13) }
      try { return { status: 200, data: JSON.parse(out) } } catch (e) { return { status: 200, raw: out } }
    }

    // 会话令牌（GET 首页 HTML 注入的 32hex，与前端同源；进程内缓存）
    let tokenCache = ''
    async function getToken() {
      if (tokenCache) return tokenCache
      let html = ''
      const web = ctx.get('web')
      if (web && typeof web.fetch === 'function') {
        try { const res = await web.fetch({ url: NILIX + '/' }); if (res && res.body && typeof res.body.content === 'string') html = res.body.content } catch (e) { /* ignore */ }
      }
      if (!html) { const r = await pwsh(`try { (Invoke-WebRequest -Uri '${NILIX}/' -UseBasicParsing -TimeoutSec 20).Content } catch { '' }`); html = r.stdout || '' }
      const m = html.match(/NILIX_TOKEN[\s\S]{0,120}?([0-9a-f]{32})/)
      const t = m ? m[1] : ((html.match(/([0-9a-f]{32})/) || [])[1] || '')
      if (t) tokenCache = t
      return t
    }

    // POST JSON（X-NiliX-Token 鉴权；单引号/换行经 JSON.stringify 安全）
    async function postJSON(path, body) {
      const tok = await getToken()
      const json = JSON.stringify(body || {})
      const cmd = [
        `$ErrorActionPreference = 'Stop'`,
        `$b = '${json.replace(/'/g, "''")}'`,
        `$h = @{}; if ('${tok}') { $h['X-NiliX-Token'] = '${tok}' }`,
        `try { $r = Invoke-RestMethod -Uri '${NILIX}${path}' -Method Post -ContentType 'application/json; charset=utf-8' -Headers $h -Body $b -TimeoutSec 900; $r | ConvertTo-Json -Depth 12 } catch { $d = $_.ErrorDetails.Message; if (-not $d) { $d = $_.Exception.Message }; Write-Output ('__NILIX_ERR__' + $d) }`,
      ]
      const r = await pwsh(cmd, { timeoutMs: 960000 })
      const out = (r.stdout || '').trim()
      if (out.startsWith('__NILIX_ERR__')) return { ok: false, error: out.slice(13).slice(0, 2000) }
      try { return { ok: true, data: JSON.parse(out) } } catch (e) { return { ok: true, raw: out } }
    }

    // multipart POST（gacha upload 图片）
    async function postMultipart(path, fields, filePath) {
      const tok = await getToken()
      const h = tok ? `$h = @{'X-NiliX-Token'='${tok}'}` : '$h = @{}'
      const form = []
      for (const k of Object.keys(fields || {})) form.push(`'${k}'='${String(fields[k]).replace(/'/g, "''")}'`)
      form.push(`'file'=Get-Item -LiteralPath '${filePath}'`)
      const r = await pwsh([
        `$ErrorActionPreference = 'Stop'`, h,
        `$f = @{ ${form.join('; ')} }`,
        `try { $r = Invoke-RestMethod -Uri '${NILIX}${path}' -Method Post -Headers $h -Form $f -TimeoutSec 600; $r | ConvertTo-Json -Depth 10 } catch { $d = $_.ErrorDetails.Message; if (-not $d) { $d = $_.Exception.Message }; Write-Output ('__NILIX_ERR__' + $d) }`,
      ], { timeoutMs: 660000 })
      const out = (r.stdout || '').trim()
      if (out.startsWith('__NILIX_ERR__')) return { ok: false, error: out.slice(13).slice(0, 2000) }
      try { return { ok: true, data: JSON.parse(out) } } catch (e) { return { ok: true, raw: out } }
    }

    // Python 解释器探测（缓存）
    let pyCmd = ''
    async function python() {
      if (pyCmd) return pyCmd
      for (const cand of ['python', 'py']) {
        const r = await pwsh(`${cand} --version`)
        if (r.exitCode === 0) { pyCmd = cand; return cand }
      }
      pyCmd = 'python'
      return pyCmd
    }

    // 文件操作（strict：失败抛错可见）
    const fexists = async (p) => (await pwsh(`Test-Path -LiteralPath '${p}'`)).stdout.trim() === 'True'
    const fread = async (p) => (await pwsh(`$ErrorActionPreference='Stop'; Get-Content -LiteralPath '${p}' -Raw -Encoding UTF8`, { strict: true })).stdout || ''
    const fmkdir = async (p) => pwsh(`$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '${p}' | Out-Null`, { strict: true })
    const fcopy = async (s, d) => pwsh(`$ErrorActionPreference='Stop'; Copy-Item -LiteralPath '${s}' -Destination '${d}' -Force`, { strict: true })
    const fwrite = async (p, content) => {
      const b64 = Buffer.from(String(content), 'utf-8').toString('base64')
      await pwsh(`$ErrorActionPreference='Stop'; [System.IO.File]::WriteAllBytes('${p}', [Convert]::FromBase64String('${b64}'))`, { strict: true })
    }
    const fbackup = async (p) => {
      if (!(await fexists(p))) return false
      await pwsh(`$ErrorActionPreference='Stop'; Copy-Item -LiteralPath '${p}' -Destination '${p}.bak-${Date.now()}' -Force`, { strict: true })
      return true
    }

    // 基础工具函数
    const str = (v, d) => (v === undefined || v === null) ? (d === undefined ? '' : d) : String(v)
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
    const has = (v) => v !== undefined && v !== null && String(v).trim() !== ''
    function mergeObj(base, patch) {
      const out = Object.assign({}, base || {})
      for (const k of Object.keys(patch || {})) {
        const v = patch[k]
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = mergeObj(out[k], v)
        else if (v !== undefined) out[k] = v
      }
      return out
    }

    // H3 合规（官方：VAE 32× 网格 / 上限 768×1344 短边 768 / 风格 8 预设可+组合）
    const align32 = (n) => Math.max(128, Math.floor(n / 32) * 32)
    function styleHint(style) {
      if (!style) return ''
      const first = String(style).split('+')[0].trim().toLowerCase()
      if (H3_STYLES.includes(first)) return ''
      if (/^[a-zA-Z0-9 ,-]{3,}$/.test(String(style))) return ''
      return '未知风格「' + style + '」：可选 ' + H3_STYLES.join('/') + '（可 + 组合或英文自定义）；中文描述建议先用 manju_render_agent style 分析'
    }
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

    // 工具工厂：统一 output/render/wrap（所有工具返回 {ok,...}）
    const renderJson = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const wrap = (fn) => async (args) => {
      try { return await fn(args || {}) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    }
    const tool = (name, description, properties, required, execute) => ({
      name, description,
      parameters: { type: 'object', properties, required: required || [] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true }, render: renderJson },
      execute: wrap(execute),
    })
    const S = (d) => ({ type: 'string', description: d })
    const I = (d) => ({ type: 'integer', description: d })
    const B = (d) => ({ type: 'boolean', description: d })

    // 标题解析（素材抽取用）：'前缀：名称' 优先；无冒号仅 3 级+ 且排除节关键词
    const SECTION_KEYWORDS = /大纲|设定|场景|世界观|立项|地图|环境|规则|金手指|等级|目录|人物|角色|卷|章/
    function parseSectionTitle(line) {
      const m = line.match(/^#+\s*(?:\d+[.、]?\s*)?(.{1,14}?)[：:]\s*([^（(\s]{1,14})/)
      if (m && m[1] && m[2]) return { title: m[1].trim(), name: m[2] }
      if (!/^#{3,}\s/.test(line)) return null
      const plain = line.replace(/^#+\s*/, '').trim()
      if (!plain || plain.length > 24 || SECTION_KEYWORDS.test(plain)) return null
      return { title: '', name: plain }
    }
    const headingLevel = (line) => { const m = line.match(/^#+/); return m ? m[0].length : 0 }

    // ═══════════════════════════════════════════════════════════════════════
    // M1 小说创作域（shuangwen-novel 承接：本地脚手架 + NiliX 网页版双路径）
    // ═══════════════════════════════════════════════════════════════════════
    const novel = {
      async resolveBook(project, root) {
        const base = str(root, NOVEL_ROOT) || NOVEL_ROOT
        if (await fexists(base)) {
          const r = await pwsh(`Get-ChildItem -LiteralPath '${base}' -Directory | Where-Object { $_.Name -ieq '${project}' } | Select-Object -First 1 -ExpandProperty FullName`)
          const hit = (r.stdout || '').trim()
          if (hit) return hit.replace(/\\/g, '/')
        }
        return base.replace(/\\/g, '/') + '/' + project
      },
      volumePlan(chapters) {
        const n = Math.max(1, num(chapters, 56))
        const per = 7
        const nVols = Math.ceil(n / per)
        const vols = []
        for (let i = 0; i < nVols; i++) {
          const start = i * per + 1
          const end = Math.min(n, start + per - 1)
          vols.push({ index: i + 1, name: '卷' + cnNum(i + 1), start, end, count: end - start + 1 })
        }
        return vols
      },
      // 立项+脚手架（幂等：模板/立项.json 已存在不覆盖）
      async scaffold(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project（书名）' }
        const root = await this.resolveBook(project, args.root)
        const vols = this.volumePlan(args.chapters)
        for (const d of ['设定集', '正文', '素材', '封面', '全本']) await fmkdir(root + '/' + d)
        if (!(await fexists(root + '/设定集/创作指令卡-AI版本.md'))) await fcopy(SKILL + '/references/创作指令卡-模板.md', root + '/设定集/创作指令卡-AI版本.md')
        if (!(await fexists(root + '/设定集/章节写作规范.md'))) await fcopy(SKILL + '/references/章节写作规范.md', root + '/设定集/章节写作规范.md')
        let lx
        const lxPath = root + '/立项.json'
        if (await fexists(lxPath)) { try { lx = JSON.parse(await fread(lxPath)) } catch (e) { lx = null } }
        if (!(lx && lx.project === project && args.chapters === undefined)) {
          lx = { project, root, genre: str(args.genre), style: str(args.style), chapters: vols.reduce((s, v) => s + v.count, 0), volumes: vols, created_at: new Date().toISOString() }
          await fwrite(lxPath, JSON.stringify(lx, null, 2))
        }
        return {
          ok: true, project, root, genre: lx.genre, style: lx.style, chapters: lx.chapters, volumes: lx.volumes,
          files: ['设定集/创作指令卡-AI版本.md', '设定集/章节写作规范.md', '立项.json'], reused: true,
          next: ['写 设定集/设定集与大纲.md（人物含写实电影级英文提示词/世界观含灵力等级/金手指含代价/分章大纲）', '按 volumes 建 正文/卷X_卷名 目录', '对每卷调 manju_novel_dispatch 取派发 prompt → 并行派写章子代理'],
        }
      },
      // 卷大纲抽取（节匹配 → 章号过滤 → 全文兜底）
      extractVolumeOutline(text, vol) {
        const lines = String(text).split(/\r?\n/)
        const names = [vol.name, '卷' + vol.index, '卷' + cnNum(vol.index)]
        const out = []
        let inSection = false
        for (const raw of lines) {
          const line = raw.trim()
          if (!line) continue
          if (line.startsWith('#')) { inSection = names.some((n) => n && line.includes(n)); continue }
          if (inSection && (line.startsWith('-') || line.startsWith('*'))) out.push(line.replace(/^[-*]\s+/, ''))
        }
        if (out.length) return { lines: out, mode: 'section' }
        const all = lines.filter((l) => { const t = l.trim(); return t && !t.startsWith('#') && (t.includes('—') || t.includes('｜')) })
        const numbered = all.filter((l) => /第0*\d+章/.test(l))
        if (numbered.length) return { lines: all.filter((l) => { const m = l.match(/第0*(\d+)章/); return m ? (Number(m[1]) >= vol.start && Number(m[1]) <= vol.end) : true }), mode: 'fallback-numbered' }
        return { lines: all, mode: 'fallback-all' }
      },
      // 卷写章派发 prompt
      async dispatch(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const root = await this.resolveBook(project, args.root)
        const lxPath = root + '/立项.json'
        if (!(await fexists(lxPath))) return { ok: false, error: '缺少 立项.json：先 manju_novel_scaffold' }
        let lx
        try { lx = JSON.parse(await fread(lxPath)) } catch (e) { return { ok: false, error: '立项.json 解析失败：' + e.message } }
        const q = String(args.volume).trim()
        const vol = lx.volumes.find((v) => String(v.index) === q || String(v.name) === q || v.name.startsWith(q))
        if (!vol) return { ok: false, error: '卷不存在: ' + q + '；可选: ' + lx.volumes.map((v) => v.index + ':' + v.name).join(', ') }
        const outlinePath = root + '/设定集/设定集与大纲.md'
        if (!(await fexists(outlinePath))) return { ok: false, error: '缺少 设定集/设定集与大纲.md：先写设定集（含分章大纲）再派发' }
        const ex = this.extractVolumeOutline(await fread(outlinePath), vol)
        if (!ex.lines.length) return { ok: false, error: '卷' + vol.index + ' 大纲行未识别：请在 设定集/设定集与大纲.md 的「四、' + vol.name + ' 大纲」节逐行写 章节名 — 剧情｜爽点｜伏笔' }
        const prevHint = vol.index === 1 ? '全书第一卷：开篇直接写“开局暴击”事件现场，不铺垫背景介绍' : '第' + (vol.start - 1) + '章结尾的场景（从上一卷大纲行摘一句话）'
        const nextHint = '为下一卷铺垫：第' + (vol.end + 1) + '章起的新局面'
        const prompt = DISPATCH_TPL
          .replace(/<书名>/g, project).replace(/<卷名>/g, vol.name).replace(/<本卷章节数>/g, String(vol.count))
          .replace(/<起章号>/g, String(vol.start)).replace(/<止章号>/g, String(vol.end))
          .replace(/<项目根目录>/g, root).replace(/<技能目录>/g, SKILL)
          .replace(/<每章大纲>/g, ex.lines.join('\n'))
          .replace(/<衔接上一卷>/g, prevHint).replace(/<衔接下一卷>/g, nextHint)
        return { ok: true, project, volume: vol, outlineMode: ex.mode, outlineLines: ex.lines.length, prompt, note: '把 prompt 原文作为写章子代理输入；子代理先读 章节写作规范.md、写作技法速查卡、违规词库；章节名唯一；单章 1400-1550 字。' }
      },
      // QA 全量校验
      async qa(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const root = await this.resolveBook(project, args.root)
        const extra = args.strict ? ' --strict-max' : ''
        const r = await pwsh(`${await python()} "${SKILL}/scripts/qa_check.py" --root "${root}" --check-dup-name --check-end-mark${extra}`, { timeoutMs: 240000 })
        const output = (r.stdout + '\n' + r.stderr).trim()
        return { ok: r.exitCode === 0, pass: r.exitCode === 0, exitCode: r.exitCode, output }
      },
      // 封面生成
      async cover(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const root = await this.resolveBook(project, args.root)
        const pos = root + '/封面/pos.txt'
        if (!(await fexists(pos))) return { ok: false, error: '缺少 ' + pos + '：先写正向提示词（写实电影级，参考 素材/人物生成提示词.md 风格），可加 封面/neg.txt' }
        let cmd = `${await python()} "${SKILL}/scripts/gen_cover.py" --out "${root}/封面/封面.png" --pos "${pos}" --neg-bank "${str(args.negBank, '通用禁日漫风')}"`
        if (await fexists(root + '/封面/neg.txt')) cmd += ` --neg "${root}/封面/neg.txt"`
        if (str(args.model)) cmd += ' --model ' + str(args.model)
        if (args.seed !== undefined && args.seed !== null) cmd += ' --seed ' + num(args.seed, 0)
        const r = await pwsh(cmd, { timeoutMs: 600000, workdir: root + '/封面' })
        const output = (r.stdout + '\n' + r.stderr).trim()
        return { ok: r.exitCode === 0, exitCode: r.exitCode, output, image: root + '/封面/封面.png' }
      },
      // 素材导出：设定集 → NiliX scanNovelAssets 直用（人物/场景提示词）
      async materials(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const root = await this.resolveBook(project, args.root)
        const outlinePath = root + '/设定集/设定集与大纲.md'
        if (!(await fexists(outlinePath))) return { ok: false, error: '缺少 设定集/设定集与大纲.md：先写设定集再导出素材' }
        const text = await fread(outlinePath)
        const chars = extractCharacters(text)
        const scenes = extractScenes(text)
        const backedUp = []
        for (const f of ['素材/人物生成提示词.md', '素材/场景提示词.md']) if (await fbackup(root + '/' + f)) backedUp.push(f)
        await fwrite(root + '/素材/人物生成提示词.md', buildCharMd(project, chars))
        await fwrite(root + '/素材/场景提示词.md', buildSceneMd(project, scenes))
        const missingEn = chars.filter((c) => !c.prompts.length).map((c) => c.name)
        return {
          ok: true, project, root, characters: chars.length, scenes: scenes.length,
          files: ['素材/人物生成提示词.md', '素材/场景提示词.md'], backedUp, missingEnglishPrompts: missingEn,
          note: '素材 md 被 NiliX scanNovelAssets 注入 plan（CharPrompt/ScenePrompt）；缺英文提示词角色已列出，补写进 设定集 后重跑；旧素材已备份 .bak-*。',
        }
      },
      // 全本合并
      async assemble(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const root = await this.resolveBook(project, args.root)
        const r = await pwsh(`${await python()} "${SKILL}/scripts/assemble_full.py" --root "${root}" --title "${project}"`, { timeoutMs: 180000 })
        const output = (r.stdout + '\n' + r.stderr).trim()
        return { ok: r.exitCode === 0, exitCode: r.exitCode, output, full: root + '/全本/' + project + '·全本.md' }
      },
      // NiliX 网页版创作（LLM 直出）
      async web(args) {
        const action = str(args.action).trim()
        switch (action) {
          case 'create': {
            const title = str(args.title).trim()
            if (!title) return { ok: false, error: '缺少 title（书名）' }
            const body = { title }
            if (str(args.genre)) body.genre = str(args.genre)
            if (str(args.style)) body.style = str(args.style)
            if (args.chapters !== undefined && args.chapters !== null) body.chapters = num(args.chapters, 56)
            return Object.assign({ ok: true, action }, await postJSON('/api/novel/create', body))
          }
          case 'chapter': case 'review': {
            const title = str(args.title).trim(); const no = num(args.no, 0)
            if (!title || !no) return { ok: false, error: '缺少 title / no（章号）' }
            return Object.assign({ ok: true, action }, await postJSON('/api/novel/' + action, { title, no }))
          }
          case 'analyze': {
            const body = {}
            if (str(args.genre)) body.genre = str(args.genre)
            if (str(args.style)) body.style = str(args.style)
            return Object.assign({ ok: true, action }, await postJSON('/api/novel/analyze', body))
          }
          case 'progress': {
            const title = str(args.title).trim()
            if (!title) return { ok: false, error: '缺少 title' }
            return Object.assign({ ok: true, action }, await getJSON('/api/novel/progress?title=' + encodeURIComponent(title)))
          }
          case 'auto': case 'auto-stop': {
            const title = str(args.title).trim()
            if (!title) return { ok: false, error: '缺少 title' }
            return Object.assign({ ok: true, action }, await postJSON('/api/novel/' + action, { title }))
          }
          case 'auto-status': {
            const title = str(args.title).trim()
            return Object.assign({ ok: true, action }, await getJSON('/api/novel/auto/status' + (title ? '?title=' + encodeURIComponent(title) : '')))
          }
          case 'status-all': return Object.assign({ ok: true, action }, await getJSON('/api/novel/status/all'))
          default: return { ok: false, error: '未知 action: ' + action + '；可选 create|chapter|review|analyze|progress|auto|auto-stop|auto-status|status-all' }
        }
      },
    }

    // 素材抽取器
    function extractCharacters(text) {
      const lines = String(text).split(/\r?\n/)
      const out = []
      let inCharSection = false
      let cur = null
      const flush = () => { if (cur && cur.name) out.push(cur) }
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (line.startsWith('#')) {
          const lvl = headingLevel(line)
          if (lvl <= 2) {
            const isCharHead = line.includes('人物') || line.includes('角色')
            if (isCharHead) { inCharSection = true; flush(); cur = null; continue }
            if (inCharSection) { flush(); inCharSection = false; cur = null }
            continue
          }
          if (inCharSection) {
            const h = parseSectionTitle(line)
            if (h) { flush(); cur = { name: h.name, title: h.title, memory: '', prompts: [] }; continue }
          }
          continue
        }
        if (!inCharSection || !cur) continue
        if (line.startsWith('- **记忆点') || line.includes('记忆点')) { cur.memory = line.replace(/^-\s*\*\*?记忆点\*\*?[：:]?\s*/, ''); continue }
        if (/^[-*]\s*\*\*?[^\s*]{1,10}\*\*?[：:]/.test(line) && !cur.name) {
          const m = line.match(/[：:]\s*([^，,。\s]{1,12})/)
          if (m) { cur.name = m[1]; cur.title = line.replace(/^-\s*\*\*?/, '').split(/[：:]/)[0] }
          continue
        }
        if (/Cinematic|photorealistic|film still|movie poster/.test(line) || /^```/.test(line)) {
          const p = line.replace(/^```/, '').trim()
          if (p) cur.prompts.push(p)
        }
      }
      flush()
      return out
    }
    function extractScenes(text) {
      const lines = String(text).split(/\r?\n/)
      const out = []
      let inSceneSection = false
      let cur = null
      const flush = () => { if (cur && cur.name) out.push(cur) }
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (line.startsWith('#')) {
          const lvl = headingLevel(line)
          if (lvl <= 2) {
            const isSceneHead = line.includes('场景') || line.includes('世界观') || line.includes('地图') || line.includes('地点')
            if (isSceneHead) { inSceneSection = true; flush(); cur = null; continue }
            if (inSceneSection) { flush(); inSceneSection = false; cur = null }
            continue
          }
          if (inSceneSection) {
            const h = parseSectionTitle(line)
            if (h) { flush(); cur = { name: h.name, title: h.title, description: '', prompts: [] }; continue }
          }
          continue
        }
        if (!inSceneSection || !cur) continue
        if (/Cinematic|photorealistic|film still/.test(line)) { cur.prompts.push(line.replace(/^```/, '').trim()); continue }
        const dline = line.replace(/^[-*]\s*\*\*?[^\s*]{1,12}\*\*?[：:]\s*/, '').trim()
        if (dline && cur.description.length < 400 && (dline.includes('：') || dline.includes('，') || dline.length > 8)) cur.description += (cur.description ? '；' : '') + dline
      }
      flush()
      return out
    }

    const NEG_COMMON = 'anime, cartoon, illustration, manga, chibi, doll, 3d render, plastic skin, flat lighting, watermark, text, letters, logo, signature, deformed, extra fingers, extra limbs, low quality, blurry, oversaturated, heavy makeup'
    function buildCharMd(project, chars) {
      const parts = [
        '# 《' + project + '》人物生成提示词（写实电影级 · 禁日漫风 · NiliX 漫剧定妆直用）', '',
        '> 用途：NiliX 漫剧定妆照/分镜参考（scanNovelAssets → CharPrompt 注入 plan 系统提示词）。',
        '> 正向词结构：Cinematic film still, photorealistic + 年龄/东方特征 + 3 个具体外貌记忆点 + 神态 + 环境光 + 镜头参数。',
        '> 半身/正脸、头部完整居中（含发顶到下巴）优先——定妆照将作为 H3 Ref2VA 的 <Picture N> 身份锁定源，',
        '> 跨镜外观须与 Subject 描述逐字一致（官方 Full-Reference 指南 §5.3：同一标签后续复用不重定义，禁编造特征）。',
        '> 通用负向词（所有角色追加）：' + NEG_COMMON,
      ]
      for (const c of chars) {
        parts.push('', '## ' + (c.title ? c.title + '：' : '') + c.name)
        if (c.memory) parts.push('- **记忆点**：' + c.memory)
        if (c.prompts.length) { parts.push('- **提示词**：'); for (const p of c.prompts) parts.push('  ' + p) }
        else parts.push('- **提示词**：`待补写实电影级英文提示词（Cinematic film still, photorealistic + 外貌记忆点 + 神态 + 环境光 + 85mm lens, shallow depth of field, ultra detailed, 8k, movie poster quality）`')
      }
      return parts.join('\n')
    }
    function buildSceneMd(project, scenes) {
      const parts = ['# 《' + project + '》场景提示词（NiliX 漫剧场景图直用）', '', '> 用途：NiliX 漫剧场景图/分镜参考（scanNovelAssets → ScenePrompt 注入 plan）。空场景无人物，明亮清晰，与人物提示词同一画风。']
      for (const s of scenes) {
        parts.push('', '## ' + (s.title ? s.title + '：' : '') + s.name)
        if (s.description) parts.push('- **描述**：' + s.description)
        if (s.prompts.length) { parts.push('- **提示词**：'); for (const p of s.prompts) parts.push('  ' + p) }
        else parts.push('- **提示词**：`待补英文场景提示词（Cinematic film still, photorealistic, empty scene of 场景名, 空间/材质/光线/氛围, 85mm lens, ultra detailed, 8k）`')
      }
      if (!scenes.length) parts.push('', '> 未在设定集识别到场景节：请在 设定集/设定集与大纲.md 补充“场景/世界观”节（场景名 + 空间/光线/氛围描述），或手工编辑本文件。')
      return parts.join('\n')
    }

    const DISPATCH_TPL = [
      '你是资深中文网文作家，为爽文小说《<书名>》撰写**<卷名>**的全部 <本卷章节数> 章正文。', '',
      '【动笔前必读】',
      '1. 读 <项目根目录>/设定集/章节写作规范.md（硬性要求，逐条执行）',
      '2. 读 <技能目录>/references/写作技法速查卡.md（人物/表情/动作/场景/镜头五类技法速查）',
      '3. 读 <项目根目录>/设定集/设定集与大纲.md 中：二、人物设定；三、世界观（灵力等级表、金手指铁律与代价）；四、<卷名> 大纲',
      '4. 简读 <项目根目录>/设定集/创作指令卡-AI版本.md 的 D、E 节',
      '5. 读 <技能目录>/wordbank/违规词库.md：正文规避全部 [硬禁] 词条；[慎用] 词条用间接表达', '',
      '【输出】每章一个文件，UTF-8，写到：',
      '<项目根目录>/正文/<卷名>/第<起章号>章_<章节名>.md …直到第<止章号>章。文件名：第NNN章_章节名.md；首行 # 第NNN章 章节名；正文不加标题不加粗。', '',
      '【硬性规范】',
      '1. 章节名全书唯一：不得与全书已有章节重名；口癖式章名复用加（二）（三）后缀',
      '2. 单章字数 1400–1550（硬下限 1280，硬上限 1800）',
      '3. 若本卷含全书最后一章，末尾必须落“（全书完）”', '',
      '【<卷名>大纲（严格照写，可加细节不可改主线）】',
      '<每章大纲>', '',
      '【衔接】第<起章号>章开头接上一卷末章结尾（<衔接上一卷>）。第<止章号>章结尾为下一卷铺垫（<衔接下一卷>）。', '',
      '【返回】只返回：<本卷章节数> 个文件名 + 各自字数统计数字 + 一句自评。不要粘贴正文。',
    ].join('\n')

    // ═══════════════════════════════════════════════════════════════════════
    // M2 渲染域（自研引擎，零 NiliX 依赖：ComfyUI 8190 直连 + DeepSeek + FFmpeg）
    // ═══════════════════════════════════════════════════════════════════════
    const engine = createEngine(ctx)
    const E = engine // 别名：E.str / E.num / E.has / E.normPath / E.md5 ...（幂等，工具与面板共用）

    // 本地 ffmpeg/ffprobe 路径探测（FFMPEG_DIR 环境变量优先，系统 PATH 兜底）
    async function ffmpegPath() {
      const p = FFMPEG_DIR_DEF + '/ffmpeg.exe'
      if (await fexists(p)) return p
      return 'ffmpeg'
    }
    async function ffprobePath() {
      const p = FFMPEG_DIR_DEF + '/ffprobe.exe'
      if (await fexists(p)) return p
      return 'ffprobe'
    }

    // 角色抽卡（自研本地：Z-Image 抽卡 / 采纳 / 上传；需 plan 已出角色；2026-08-24 支持视图 + 拟漫化）
    async function localGacha(cfg, cfgPath, workdir, args) {
      const action = str(args.action).trim()
      const ep = str(args.episode, 'EP01')
      const analysisDir = workdir + '/analysis'
      const planPath = analysisDir + '/' + ep + '_direct_plan.json'
      if (!(await fexists(planPath))) return { ok: false, error: '方案不存在：先跑 plan' }
      const plan = JSON.parse(await fread(planPath))
      const chars = (plan.characters || []).map((m) => ({ id: str(m.id), role: str(m.role), gender: str(m.gender), image_prompt: str(m.image_prompt), appearance: str(m.appearance), costume: str(m.costume), views: (m.views && typeof m.views === 'object') ? m.views : {} }))
      const render = Object.assign(engine.defaultRender(), cfg.render || {})
      const assetsDir = workdir + '/assets/characters'
      const comfy = engine.comfyClient(render.comfy_url || COM_URL_DEF)
      const view = str(args.view, '').trim()
      if (action === 'draw') {
        const char = str(args.char).trim()
        const c = chars.find((x) => x.id === char)
        if (!c) return { ok: false, error: '角色不存在: ' + char + '；可选: ' + chars.map((x) => x.id).join(', ') }
        const sd = engine.styleDesc(str(cfg.style, 'real'))
        // 视图抽卡：front/full/side/detail 基于主图 img2img 保身份；q 仅正角；空=主图拟漫化文生图
        let prompt = c.image_prompt || ('Cinematic film still, ' + sd.asset + ', character portrait of ' + c.appearance + ' wearing ' + c.costume + ', front-facing, 85mm lens, ultra detailed')
        if (view && view !== 'front' && view !== 'main') {
          const vs = (c.views && typeof c.views === 'object') ? c.views : {}
          prompt = str(vs[view]) || (prompt + ', ' + engine.viewSuffix(view))
          if (view === 'q') {
            if (c.role === '反派' || c.role === '功能配角') return { ok: false, error: 'Q 版仅限正角（2026-08-24 用户规则）：' + char + ' 的 role=' + (c.role || '未标记') }
            const g = str(c.gender)
            const genderEn = g === '女' ? ', a cute girl, feminine face, slender figure, wearing the character\'s outfit' : (g === '男' ? ', a cute boy, masculine face, broader figure, wearing the character\'s outfit' : '')
            prompt = (str(vs.q) || 'chibi cute style, cute big eyes, small chibi body') + genderEn + ', ' + (c.image_prompt || '') + ', fully clothed, wearing the character\'s full costume from head to toe, no nudity, no shirtless, no topless, no underwear, no exposed skin except face and hands'
          }
        }
        prompt = engine.portraitPrompt(prompt, c.appearance)
        const seed = engine.charSeed(c.id, view || 'main')
        // 视图抽卡：主图作 img2img 起点保身份（Z-Image 已验证）
        let mainRef = ''
        let strength = 0
        if (view && view !== 'front' && view !== 'main') {
          const mainImg = assetsDir + '/' + engine.safeName(char) + '.png'
          if (await fexists(mainImg)) {
            const comfyInputDir = normPath((cfg.paths && cfg.paths.comfy_input) || COM_INPUT_DEF)
            const refName = 'dir_char_main_' + engine.safeName(char) + '.png'
            if (!(await fexists(comfyInputDir + '/' + refName))) await engine.copyBinary(mainImg, comfyInputDir + '/' + refName)
            mainRef = refName
            strength = view === 'detail' ? 0.7 : (view === 'side' ? 0.85 : 0.82)
          }
        }
        const wf = engine.wfZImage(prompt, render, seed, 1024, 1024, 'manju_gacha', str(render.neg_prompt), mainRef, strength)
        if (!wf) return { ok: false, error: '引擎 wfZImage 未导出（内部错误）' }
        const r = await comfy.submit(wf)
        if (!r.ok) return { ok: false, error: '抽卡提交失败: ' + r.error }
        const w = await comfy.wait(r.prompt_id, 900000, 5000)
        if (!w.ok) return { ok: false, error: '抽卡失败: ' + w.error }
        const entry = await comfy.history(r.prompt_id)
        const media = comfy.outputFiles(entry).find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f.filename))
        const f = await comfy.fetch(media, workdir + '/assets/characters/_gacha')
        if (!f.ok) return { ok: false, error: '取回失败: ' + f.error }
        return { ok: true, action, char, view: view || 'main', candidate: f.path, note: '用 manju_render_gacha adopt 采纳（image=候选图路径' + (view ? '，view=' + view : '') + '）' }
      }
      if (action === 'adopt') {
        const char = str(args.char).trim(); const image = str(args.image).trim()
        if (!char || !image) return { ok: false, error: '缺少 char / image（候选图绝对路径）' }
        if (!(await fexists(image))) return { ok: false, error: '文件不存在: ' + image }
        const v = view && view !== 'main' && view !== 'front' ? view : ''
        const dst = assetsDir + '/' + engine.safeName(char) + (v ? '_' + v : '') + '.png'
        await engine.fmkdir(assetsDir)
        await engine.fcopy(image, dst)
        return { ok: true, action, char, view: v || 'main', adopted: dst, note: '已采纳为正式' + (v || '主') + '视图定妆照；后续 render 将重新编码该角色镜头' }
      }
      if (action === 'upload') {
        const char = str(args.char).trim(); const image = str(args.image).trim()
        if (!char || !image) return { ok: false, error: '缺少 char / image（本地图片绝对路径，png/jpg/webp ≤20MB）' }
        if (!(await fexists(image))) return { ok: false, error: '文件不存在: ' + image }
        const v = view && view !== 'main' && view !== 'front' ? view : ''
        const dst = assetsDir + '/' + engine.safeName(char) + (v ? '_' + v : '') + '.png'
        await engine.fmkdir(assetsDir)
        await engine.fcopy(image, dst)
        return { ok: true, action, char, view: v || 'main', adopted: dst }
      }
      if (action === 'plan') {
        // LLM 直出角色方案（补写 characters image_prompt）
        const llm = await engine.loadLLM(cfg)
        const sys = '你是漫剧角色设计师。基于方案中角色的外观/服装描述，为每个角色输出英文文生图提示词（写实电影级，正面正脸、头部完整居中）。输出严格 JSON：{"characters":[{"id":"角色名","image_prompt":"英文提示词"}]}'
        const user = JSON.stringify({ characters: chars.map((c) => ({ id: c.id, gender: c.gender, appearance: c.appearance, costume: c.costume })) }, null, 2)
        const r = await engine.llmJSON(llm, sys, user, { maxTokens: 4096 })
        if (!r.ok) return { ok: false, error: r.error }
        const outChars = r.data.characters || []
        for (const oc of outChars) { const c = chars.find((x) => x.id === oc.id); if (c && oc.image_prompt) c.image_prompt = oc.image_prompt }
        plan.characters = chars
        await fwrite(planPath, JSON.stringify(plan, null, 2))
        return { ok: true, action, characters: chars.map((c) => ({ id: c.id, image_prompt: c.image_prompt })) }
      }
      return { ok: false, error: '未知 action: ' + action + '；可选 draw|adopt|upload|plan' }
    }

    const render = {
      cfgPath(project, manjuRoot) { return manjuRoot + '/' + project + '/config.json' },
      projectDir(cfgPath) { return cfgPath.replace(/\/config\.json$/, '') },
      async resolveManjuRoot() {
        // 本地解析（不再调 NiliX /api/manju/paths）
        return engine.resolveManjuRoot()
      },
      async comfyDirs(cfg) {
        // 本地解析 Comfy 目录（config.paths 优先，常量兜底）
        return engine.comfyDirs(cfg || null)
      },
      defaultRender() {
        return {
          width: 768, height: 1344, fps: 24, steps: 20, turbo_steps: 8, seed: 1688, min_shot_seconds: 4, max_shot_seconds: 12,
          comfy_url: 'http://127.0.0.1:8190',
          neg_prompt: 'lowres, bad anatomy, bad hands, text, error, extra digit, no text, no watermark, no deformed hands, flickering frames, temporal discontinuity, inconsistent lighting',
          unet_fl2va: 'MiniMax_H3_fl2va_pruned_int8_convrot.safetensors', unet_ref2va: 'MiniMax_H3_ref2va_pruned_int8_convrot.safetensors',
          clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', vae_video: 'minimax_h3_video_vae_fp16.safetensors', vae_audio: 'minimax_h3_audio_vae_fp32.safetensors',
          z_image_unet: 'z_image_turbo_bf16.safetensors', z_image_clip: 'qwen_3_4b.safetensors', z_image_vae: 'ae.safetensors',
          turbo_lora: 'minimax_h3_turbo_4step_ema.safetensors', turbo_lora_r2v: 'minimax_h3_turbo_4step_ema.safetensors',
          animagine_ckpt: 'animagine-xl-3.1.safetensors',
          char_models: { 男: 'sd_xl_base_1.0.safetensors', 女: 'animagine-xl-3.1.safetensors' },
          chapters: '', episode: '0',
          fl2va_end_frame: false,
        }
      },
      // 生成/更新 config.json（渲染参数保留已有值；仅显式传参覆盖；paths 强制）
      async config(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const bookRoot = await novel.resolveBook(project, args.novelRoot)
        let novelFile = ''
        const fullDir = bookRoot + '/全本'
        if (await fexists(fullDir)) {
          const r = await pwsh(`Get-ChildItem -LiteralPath '${fullDir}' -Filter *.md | Select-Object -ExpandProperty FullName`)
          const files = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\\/g, '/'))
          novelFile = files.find((f) => f.indexOf(project + '·全本') >= 0) || files[0] || ''
        }
        if (!novelFile) {
          const r = await pwsh(`Get-ChildItem -LiteralPath '${bookRoot}/正文' -Recurse -Filter 第*.md -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1 -ExpandProperty FullName`)
          novelFile = (r.stdout || '').trim().replace(/\\/g, '/')
        }
        if (!novelFile) return { ok: false, error: '找不到小说正文：需要 全本/<书名>·全本.md 或 正文/卷X/第N章_*.md（' + bookRoot + '）——先 manju_novel_assemble 生成全本' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const workdir = manjuRoot + '/' + project
        const comfy = await this.comfyDirs()
        const cfgPath = this.cfgPath(project, manjuRoot)
        let cfg = {}
        if (await fexists(cfgPath)) { try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { cfg = {} } }
        const patch = {}
        if (has(args.style)) patch.style = str(args.style)
        const llmPatch = {}
        if (has(args.llmApiKey)) llmPatch.api_key = str(args.llmApiKey)
        if (has(args.llmModel)) llmPatch.model = str(args.llmModel)
        const rPatch = {}
        for (const [camel, snake] of [['width', 'width'], ['height', 'height'], ['fps', 'fps'], ['steps', 'steps'], ['turboSteps', 'turbo_steps'], ['seed', 'seed'], ['minShotSeconds', 'min_shot_seconds'], ['maxShotSeconds', 'max_shot_seconds']]) {
          if (args[camel] !== undefined && args[camel] !== null) rPatch[snake] = num(args[camel], 0)
        }
        if (rPatch.width !== undefined) rPatch.width = align32(rPatch.width)
        if (rPatch.height !== undefined) rPatch.height = align32(rPatch.height)
        for (const [camel, snake] of STR_MAP) if (has(args[camel])) rPatch[snake] = str(args[camel])
        for (const [camel, snake] of [['sageAttention', 'sage_attention'], ['draftJudge', 'draft_judge'], ['fl2vaEndFrame', 'fl2va_end_frame']]) if (args[camel] !== undefined && args[camel] !== null) rPatch[snake] = !!args[camel]
        if (args.draftScale !== undefined && args.draftScale !== null) rPatch.draft_scale = num(args.draftScale, 0.5)
        cfg = mergeObj(cfg, patch)
        cfg.llm = mergeObj(cfg.llm || {}, llmPatch)
        cfg.render = mergeObj(this.defaultRender(), mergeObj(cfg.render || {}, rPatch))
        cfg.llm = mergeObj({ base_url: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.4, max_tokens: 8192, request_timeout: 300 }, cfg.llm)
        if (!cfg.llm.api_key) { try { const k = JSON.parse(await fread(NILIX_SERVER_CFG)); if (k.api_key) cfg.llm.api_key = k.api_key } catch (e) { /* ignore */ } }
        if (!cfg.style) cfg.style = 'real'
        if (!cfg.moderation) cfg.moderation = { banned_words: [], mosaic_enabled: false, mosaic_level: 16 }
        if (!cfg.knowledge) cfg.knowledge = {}
        cfg.paths = mergeObj(cfg.paths || {}, {
          workdir, novel: novelFile, novel_dir: bookRoot,
          analysis: workdir + '/analysis', assets: workdir + '/assets', clips: workdir + '/clips',
          comfy_input: comfy.input, comfy_output: comfy.output, outline: '', setting: '',
        })
        await fmkdir(workdir)
        await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
        return {
          ok: true, configPath: cfgPath, project, workdir, novel: novelFile, novel_dir: bookRoot,
          llmKeySet: !!cfg.llm.api_key, style: cfg.style || '', styleWarning: styleHint(cfg.style) || '',
          h3Compliance: h3ComplianceOf(cfg.render),
          note: '渲染参数保留项目已有值（仅显式传参覆盖）；宽高已按 32 倍数对齐。素材/设定集/封面 由 NiliX scanNovelAssets 自动注入 plan。',
        }
      },
      // 体检 + H3 合规（自研：ComfyUI 在线检测 + 本地 config 体检；fix 本地修复）
      async health(args) {
        const comfy = engine.comfyClient((args && args.comfyUrl) || COM_URL_DEF)
        const c = await comfy.online()
        if (!c.online) return { ok: false, platform: 'down', comfy: { online: false, error: str(c.error) }, error: 'ComfyUI 未运行（' + COM_URL_DEF + '）：先 manju_render_comfy start 再继续' }
        const project = str(args.project).trim()
        if (!project) return { ok: true, platform: 'up', comfy: { online: true, comfyui_version: str(c.comfyui_version), device: str(c.device), vram_total: num(c.vram_total, 0) }, note: 'ComfyUI 在线；未指定 project，跳过项目体检' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, platform: 'up', comfy: c, error: 'config.json 不存在：先 manju_render_config' }
        // 本地体检：config 存在 / llm key / render 合规 / 小说存在
        const checks = []
        let cfg = {}
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { cfg = {} }
        checks.push({ key: 'config', name: 'config.json', passed: true, message: cfgPath })
        const llmKey = !!(cfg.llm && cfg.llm.api_key)
        checks.push({ key: 'llm_key', name: 'DeepSeek Key', passed: llmKey, message: llmKey ? '已配置' : '缺失（config.llm.api_key 或 server/settings.json）' })
        const novelFile = cfg.paths && cfg.paths.novel
        const novelOk = novelFile && await fexists(novelFile)
        checks.push({ key: 'novel', name: '小说正文', passed: !!novelOk, message: novelOk ? novelFile : '缺失（' + (novelFile || 'paths.novel 未配置') + '）' })
        const compliance = h3ComplianceOf(cfg.render)
        checks.push({ key: 'h3', name: 'H3 合规', passed: compliance.aligned, message: compliance.aligned ? (compliance.width + '×' + compliance.height + ' 合规') : ('短边 ' + compliance.shortEdge + ' 或面积超限（' + compliance.width + '×' + compliance.height + '）') })
        let styleWarn = ''
        if (cfg.style) styleWarn = styleHint(cfg.style)
        checks.push({ key: 'style', name: '风格', passed: !styleWarn, message: str(styleWarn || cfg.style) })
        // 权重完整性（2026-08-18 知识库：音频 VAE 缺失=黑屏最高频故障；int8 剪枝为工业化主力）
        const sharedModels = normPath((cfg.paths && cfg.paths.comfy_shared) || (userProfile + '/AppData/Local/Comfy-Desktop/ComfyUI-Shared/models'))
        const modelCheck = async (label, name) => {
          if (!name) return null
          const dirs = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'unet', 'checkpoints', 'clip']
          for (const d of dirs) {
            if (await fexists(sharedModels + '/' + d + '/' + name)) return { key: 'model_' + label, name: label, passed: true, message: name }
          }
          return { key: 'model_' + label, name: label, passed: false, message: name + '（未在共享 models 找到；音频 VAE 缺失会黑屏）' }
        }
        if (cfg.render) {
          for (const [label, key] of [['H3 Ref2VA UNET', 'unet_ref2va'], ['H3 FL2VA UNET', 'unet_fl2va'], ['CLIP', 'clip'], ['视频 VAE', 'vae_video'], ['音频 VAE', 'vae_audio'], ['Turbo LoRA', 'turbo_lora']]) {
            const mc = await modelCheck(label, cfg.render[key])
            if (mc) checks.push(mc)
          }
        }
        // fix：本地修复可修项
        const fixed = []
        if (args.fix) {
          const key = str(args.key)
          if ((!key || key === 'llm_key') && !llmKey) {
            try { const k = JSON.parse(await fread(NILIX_SERVER_CFG)); if (k.api_key) { cfg.llm = cfg.llm || {}; cfg.llm.api_key = k.api_key; await fwrite(cfgPath, JSON.stringify(cfg, null, 2)); fixed.push('llm_key') } } catch (e) { /* ignore */ }
          }
          if ((!key || key === 'h3') && !compliance.aligned) {
            cfg.render = cfg.render || {}
            const w = align32(cfg.render.width || 768); const h = align32(cfg.render.height || 1344)
            let sc = Math.min(w, h)
            if (sc > 768) { const k = 768 / sc; cfg.render.width = align32(Math.floor(w * k)); cfg.render.height = align32(Math.floor(h * k)) }
            else { cfg.render.width = w; cfg.render.height = h }
            await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
            fixed.push('h3')
          }
        }
        return { ok: true, platform: 'up', comfy: { online: !!c.online, comfyui_version: str(c.comfyui_version), device: str(c.device), vram_total: num(c.vram_total, 0) }, config: cfgPath, checks, h3Compliance: compliance, styleWarning: styleWarn || '', fixed }
      },
      // 阶段执行（自研：本地异步后台执行，状态落盘 run_state.json；立即返回）
      async run(args) {
        const project = str(args.project).trim()
        const phase = str(args.phase).trim()
        if (!project || !phase) return { ok: false, error: '缺少 project / phase（plan|assets|encode|render|qc|assemble|all）' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        let cfg
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { return { ok: false, error: 'config.json 解析失败: ' + e.message } }
        // episode 覆盖：0=全本默认（用 config 里的），N=第 N 章 → 章节范围
        if (args.episode !== undefined && args.episode !== null && Number(args.episode) > 0) {
          cfg.render = cfg.render || {}
          cfg.render.episode = String(Number(args.episode))
          cfg.render.chapters = String(Number(args.episode))
          await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
        }
        // 已在跑则拒绝重入
        const workdir = this.projectDir(cfgPath)
        const st = await engine.readState(workdir)
        if (st.running) return { ok: false, error: '已有任务在运行（stage=' + st.stage + '）：先 manju_render_status 查看或 manju_render_kill 停止' }
        await engine.writeState(workdir, { running: false, stage: '', currentStage: '', rc: 0, startedAt: Date.now(), stopped: false })
        const phases = engine.phasesOf(phase)
        if (!phases.length) return { ok: false, error: '未知 phase: ' + phase }
        const logger = (line) => { try { engine.appendLog(workdir, line) } catch (e) { /* ignore */ } }
        // 后台执行（不阻塞工具返回；状态/日志落盘供 status 轮询）
        ;(async () => {
          try {
            await engine.runStages(cfg, cfgPath, project, workdir, phases, { only: str(args.only), fresh: !!args.fresh, agent: !!args.agent }, logger)
          } catch (e) {
            await engine.writeState(workdir, { running: false, rc: 2, error: String((e && e.message) || e) })
            try { logger('❌ 引擎异常: ' + String((e && e.message) || e)) } catch (ee) { /* ignore */ }
          }
        })()
        return { ok: true, project, phase, config: cfgPath, workdir, phases, note: '已在本地后台启动（零 NiliX 依赖）；用 manju_render_status 轮询进度' }
      },
      // 状态轮询（本地：run_state.json + run.log + clips/analysis 产物清单）
      async status(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        const workdir = this.projectDir(cfgPath)
        let cfg = {}
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { /* ignore */ }
        const st = await engine.readState(workdir)
        const ep = (cfg.render && cfg.render.episode) || '0'
        const epName = ep === '0' ? 'EP01' : 'EP' + String(ep).padStart(2, '0')
        const out = { ok: true, project, config: cfgPath, status: st, episode: epName }
        // 产物清单：clips/<ep>/*.mp4 + 成片 + 方案
        const clipsEp = workdir + '/clips/' + epName
        const clips = (await engine.listFiles(clipsEp, '*.mp4')).sort()
        out.clips = clips.map((f) => f.split('/').pop())
        const final = workdir + '/' + epName + '_成片.mp4'
        if (await engine.fexists(final)) out.finalOutput = final
        const planPath = workdir + '/analysis/' + epName + '_direct_plan.json'
        if (await engine.fexists(planPath)) {
          try { const p = JSON.parse(await engine.fread(planPath)); out.plan = { episode_title: p.episode_title || '', characters: (p.characters || []).length, scenes: (p.scenes || []).length, shots: (p.shots || []).length } } catch (e) { /* ignore */ }
        }
        // run.log 尾部
        const logPath = workdir + '/run.log'
        if (await engine.fexists(logPath)) {
          const n = Math.min(200, Math.max(5, num(args.tailLines, 30)))
          const r = await engine.pwsh(`Get-Content -LiteralPath '${logPath}' -Tail ${n} -Encoding UTF8`)
          out.logTail = (r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-n)
        }
        return out
      },
      // 后处理（自研本地：trailer/cleanup/cleanup-sizes 本地实现；2K/剪映需云端暂不可用）
      async post(args) {
        const project = str(args.project).trim()
        const action = str(args.action).trim()
        if (!project || !action) return { ok: false, error: '缺少 project / action' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        const workdir = this.projectDir(cfgPath)
        let cfg = {}
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { /* ignore */ }
        const ep = str(args.episode, cfg.render && cfg.render.episode === '0' ? 'EP01' : 'EP' + String(cfg.render && cfg.render.episode).padStart(2, '0'))
        switch (action) {
          case 'trailer': {
            // 预告片：取该集前 N 秒片段合成
            const final = workdir + '/' + ep + '_成片.mp4'
            if (!(await fexists(final))) return { ok: false, error: '成片不存在：先跑 assemble（' + final + '）' }
            const out = workdir + '/' + ep + '_预告片.mp4'
            const target = num(args.target, 30)
            const ff = await ffmpegPath()
            const r = await engine.pwsh(`& '${ff}' -y -hide_banner -loglevel error -i '${final}' -t ${target} -c copy '${out}'`, { timeoutMs: 300000 })
            if (r.exitCode !== 0) return { ok: false, error: '预告片生成失败: ' + (r.stdout + '\n' + r.stderr).slice(0, 300) }
            return { ok: true, action, output: out }
          }
          case 'cleanup': {
            const targets = str(args.targets) ? str(args.targets).split(',').map((s) => s.trim()).filter(Boolean) : ['gacha', 'frames', '2k']
            const removed = []
            for (const t of targets) {
              if (t === 'gacha') { const g = workdir + '/assets/characters/_gacha'; if (await fexists(g)) { await engine.pwsh(`Remove-Item -LiteralPath '${g}' -Recurse -Force`); removed.push('gacha') } }
              if (t === 'frames') { const f = workdir + '/frames'; if (await fexists(f)) { await engine.pwsh(`Remove-Item -LiteralPath '${f}' -Recurse -Force`); removed.push('frames') } }
            }
            return { ok: true, action, removed }
          }
          case 'cleanup-sizes': {
            const sizes = {}
            for (const d of ['analysis', 'assets', 'clips', 'frames']) {
              const p = workdir + '/' + d
              if (await fexists(p)) {
                const r = await engine.pwsh(`$s = (Get-ChildItem -LiteralPath '${p}' -Recurse -File | Measure-Object -Property Length -Sum).Sum; [math]::Round($s / 1MB, 1)`)
                sizes[d] = Number((r.stdout || '').trim()) || 0
              } else sizes[d] = 0
            }
            return { ok: true, action, sizesMB: sizes }
          }
          case 'upscale2k': case 'upscale2k-estimate': case 'jianying': {
            return { ok: false, action, error: action + ' 依赖云端/剪映服务（原 NiliX 能力），自研引擎暂不支持；本地可用 trailer/cleanup/cleanup-sizes' }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 trailer | cleanup | cleanup-sizes（本地）' }
        }
      },
      // 停止（自研：置 stopped 标记 + ComfyUI /interrupt）
      async kill(args) {
        const project = str(args.project).trim()
        if (!project) return { ok: false, error: '缺少 project' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        const workdir = this.projectDir(cfgPath)
        await engine.writeState(workdir, { stopped: true })
        // ComfyUI interrupt（尽力而为）
        try {
          const comfy = engine.comfyClient(COM_URL_DEF)
          await engine.httpPost(COM_URL_DEF + '/interrupt', {}, {}, 8000)
        } catch (e) { /* ignore */ }
        return { ok: true, project, note: '已请求停止（stopped 标记 + ComfyUI interrupt）' }
      },
      // ComfyUI 管理（自研直连 8190）
      async comfy(args) {
        const action = str(args.action).trim()
        const comfy = engine.comfyClient(COM_URL_DEF)
        switch (action) {
          case 'status': {
            const c = await comfy.online()
            return { ok: true, action, online: !!c.online, info: { online: !!c.online, comfyui_version: str(c.comfyui_version), device: str(c.device), vram_total: num(c.vram_total, 0), error: str(c.error) } }
          }
          case 'start': {
            // 本地启动 ComfyUI：探测常见启动脚本（NiliX 代管 / Comfy-Desktop）
            const already = await comfy.online()
            if (already.online) return { ok: true, action, online: true, note: 'ComfyUI 已在运行' }
            const candidates = [
              process.env.NILIX_START_BAT || 'C:/Mi/Ai/WorkBench/NiliX/启动服务.bat',
              userProfile + '/AppData/Local/Comfy-Desktop/resources/app.asar.unpacked/ComfyUI/ComfyUI.exe',
            ]
            const started = []
            for (const c of candidates) {
              if (await fexists(c)) {
                try { await engine.pwsh(`Start-Process -FilePath '${c}' -WorkingDirectory (Split-Path '${c}')`, { timeoutMs: 15000 }); started.push(c) } catch (e) { /* ignore */ }
              }
            }
            // 等待就绪（最长 90s）
            for (let i = 0; i < 18; i++) {
              await new Promise((r) => setTimeout(r, 5000))
              const c2 = await comfy.online()
              if (c2.online) return { ok: true, action, online: true, launched: started, note: 'ComfyUI 已就绪' }
            }
            return { ok: false, action, online: false, launched: started, error: '已尝试启动但 90s 内未就绪；请手动确认 ComfyUI' }
          }
          case 'stop': {
            const r = await engine.httpPost(COM_URL_DEF + '/api/shutdown', {}, {}, 8000)
            return { ok: true, action, note: '已请求关闭（' + (r.status === 200 ? 'HTTP ' + r.status : r.error || 'ok') + '）' }
          }
          case 'install': case 'install-status': case 'install-stop': {
            return { ok: false, action, error: '安装管理需 Comfy-Desktop（原 NiliX 能力），自研引擎仅提供 status/start/stop' }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 status|start|stop' }
        }
      },
      // 角色抽卡（自研本地）
      async gacha(args) {
        const project = str(args.project).trim()
        const action = str(args.action).trim()
        if (!project || !action) return { ok: false, error: '缺少 project / action（draw|adopt|upload|plan）' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        let cfg
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { return { ok: false, error: 'config.json 解析失败: ' + e.message } }
        return localGacha(cfg, cfgPath, this.projectDir(cfgPath), args)
      },
      // 质检决策/重审（自研本地：decision 写 config；judge 本地 ffprobe；resolve 写重渲标记）
      async qc(args) {
        const project = str(args.project).trim()
        const action = str(args.action).trim()
        if (!project || !action) return { ok: false, error: '缺少 project / action（decision|judge|resolve）' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        const workdir = this.projectDir(cfgPath)
        const ep = str(args.episode, 'EP01')
        if (action === 'decision') {
          let cfg
          try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { return { ok: false, error: 'config.json 解析失败: ' + e.message } }
          if (!cfg.render || typeof cfg.render !== 'object') cfg.render = {}
          if (str(args.skip)) cfg.render.qc_skip_shots = str(args.skip).replace(/，/g, ',')
          if (args.accept !== undefined && args.accept !== null) { if (args.accept) cfg.render.qc_accept = true; else delete cfg.render.qc_accept }
          await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
          return { ok: true, action, config: cfgPath, render: { qc_skip_shots: cfg.render.qc_skip_shots || '', qc_accept: !!cfg.render.qc_accept } }
        }
        const shot = num(args.shot, 0)
        if (action === 'judge') {
          if (!shot) return { ok: false, error: '缺少 shot（镜头号）' }
          const clip = workdir + '/clips/' + ep + '/' + String(shot).padStart(2, '0') + '.mp4'
          if (!(await fexists(clip))) return { ok: false, error: '镜头文件不存在: ' + clip + '（先跑 render）' }
          // 本地 ffprobe 机械质检 + 亮度暗像素检测（黑屏兜底）
          const ff = await ffprobePath()
          const r = await engine.pwsh(`& '${ff}' -v error -show_entries stream=codec_type,codec_name -show_entries format=duration -of json '${clip}'`, { strict: true })
          let pr = {}
          try { pr = JSON.parse(r.stdout) } catch (e) { return { ok: false, error: 'ffprobe 解析失败' } }
          let duration = 0
          try { duration = Number(parseFloat(pr.format && pr.format.duration)) } catch (e) { /* ignore */ }
          let hasVideo = false, hasAudio = false
          for (const s of (pr.streams || [])) { if (s.codec_type === 'video') hasVideo = true; if (s.codec_type === 'audio') hasAudio = true }
          let darkPct = 0
          if (hasVideo && duration > 0) {
            try {
              const r2 = await engine.pwsh(`& '${ff}' -v error -i '${clip}' -vf "fps=2,signalstats,metadata=print:key=lavfi.signalstats.YMIN" -frames:v 60 -f null NUL`, { timeoutMs: 180000 })
              const lines = (r2.stdout || '').split(/\r?\n/)
              let yminCount = 0, total = 0
              for (const l of lines) { const m = l.match(/lavfi\.signalstats\.YMIN=(\d+)/); if (m) { total++; if (Number(m[1]) <= 16) yminCount++ } }
              if (total > 0) darkPct = Math.round((yminCount / total) * 100)
            } catch (e) { /* ignore */ }
          }
          const passed = duration > 0 && hasVideo && darkPct <= 50
          return { ok: true, action, shot, clip, passed, darkPct, checks: [
            { name: '时长', passed: duration > 0, message: duration.toFixed(2) + 's' },
            { name: '视频流', passed: hasVideo },
            { name: '音频流', passed: hasAudio },
            { name: '亮度', passed: darkPct <= 50, message: darkPct + '% 暗像素' + (darkPct > 50 ? '（近黑帧，需返工或调亮度护栏）' : '') },
          ], note: '本地机械质检（ffprobe + 亮度检测）；VLM 判分需云端视觉模型，自研引擎暂用机械质检' }
        }
        if (action === 'resolve') {
          const act = str(args.decision).trim()
          if (!shot) return { ok: false, error: '缺少 shot（镜头号）' }
          if (act !== 'retry' && act !== 'ignore') return { ok: false, error: '缺少 decision（retry|ignore）' }
          if (act === 'retry') {
            // 删除该镜产物 → 下次 render 自动重渲
            const clip = workdir + '/clips/' + ep + '/' + String(shot).padStart(2, '0') + '.mp4'
            if (await fexists(clip)) { await engine.fremove(clip); return { ok: true, action, shot, decision: act, note: '已删除镜头 ' + shot + ' 产物；重跑 render 即重渲' } }
            return { ok: true, action, shot, decision: act, note: '镜头 ' + shot + ' 无产物（无需清理）' }
          }
          let cfg
          try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { cfg = {} }
          if (!cfg.render) cfg.render = {}
          const skipList = String(cfg.render.qc_skip_shots || '').split(',').map((s) => s.trim()).filter(Boolean)
          if (!skipList.includes(String(shot))) skipList.push(String(shot))
          cfg.render.qc_skip_shots = skipList.join(',')
          await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
          return { ok: true, action, shot, decision: act, note: '已标记忽略镜头 ' + shot + '（合成时跳过）' }
        }
        return { ok: false, error: '未知 action: ' + action + '；可选 decision|judge|resolve' }
      },
      // 审片智能体（自研本地：settings 写 config；status 本地；chat 走 DeepSeek；style 分析）
      async agent(args) {
        const project = str(args.project).trim()
        const action = str(args.action).trim()
        if (!project || !action) return { ok: false, error: '缺少 project / action（settings|status|vision-test|style|chat）' }
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = this.cfgPath(project, manjuRoot)
        if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在：先 manju_render_config' }
        let cfg
        try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { return { ok: false, error: 'config.json 解析失败: ' + e.message } }
        switch (action) {
          case 'settings': {
            cfg.agent = cfg.agent || {}
            if (args.enabled !== undefined && args.enabled !== null) cfg.agent.enabled = !!args.enabled
            for (const [camel, snake] of [['visionBaseUrl', 'vision_base_url'], ['visionApiKey', 'vision_api_key'], ['visionModel', 'vision_model'], ['minimaxApiKey', 'minimax_api_key']]) if (has(args[camel])) cfg.agent[snake] = str(args[camel])
            if (args.passScore !== undefined && args.passScore !== null) cfg.agent.pass_score = num(args.passScore, 75)
            if (args.maxRetries !== undefined && args.maxRetries !== null) cfg.agent.max_retries = num(args.maxRetries, 2)
            if (args.judgeConcurrency !== undefined && args.judgeConcurrency !== null) cfg.agent.judge_concurrency = num(args.judgeConcurrency, 2)
            if (args.autoResolve !== undefined && args.autoResolve !== null) cfg.agent.auto_resolve = !!args.autoResolve
            await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
            return { ok: true, action, config: cfgPath, agent: cfg.agent, note: '审片判分需云端视觉模型；本地质检走 ffprobe 机械质检（manju_render_qc judge）' }
          }
          case 'status': return { ok: true, action, config: cfgPath, agent: cfg.agent || {}, note: '自研引擎：质检为本地 ffprobe 机械质检' }
          case 'vision-test': return { ok: false, action, error: '视觉模型连通测试需云端（原 NiliX 能力）；本地质检为 ffprobe 机械质检' }
          case 'style': {
            // 深度分析推荐风格：读小说样本 → LLM 推荐
            const llm = await engine.loadLLM(cfg)
            const novelFile = cfg.paths && cfg.paths.novel
            if (!novelFile || !(await fexists(novelFile))) return { ok: false, error: '缺少小说正文（paths.novel）' }
            const text = (await engine.fread(novelFile)).slice(0, 4000)
            const sys = '你是漫剧风格顾问。根据小说内容推荐渲染风格，从 2.5d/real/3d/anime/handdrawn/papercraft/clay/ink 中选择或组合（可+自定义英文）。输出严格 JSON：{"style":"real","reason":"一句话理由","tone":"色调/光影建议"}'
            const r = await engine.llmJSON(llm, sys, text, { maxTokens: 1024 })
            if (!r.ok) return { ok: false, error: r.error }
            return { ok: true, action, recommend: r.data, styles: H3_STYLES }
          }
          case 'chat': {
            const text = str(args.text).trim()
            if (!text) return { ok: false, error: '缺少 text（自然语言指令）' }
            const llm = await engine.loadLLM(cfg)
            const status = await this.status({ project, manjuRoot })
            const sys = '你是漫剧一条龙智能体。根据项目状态回答用户的自然语言指令，给出可执行的下一步（明确到工具与参数）。简洁中文。'
            const user = '【项目】' + project + '\n【状态】' + JSON.stringify(status).slice(0, 3000) + '\n【指令】' + text
            const r = await engine.llmChat(llm, [{ role: 'system', content: sys }, { role: 'user', content: user }], 2048, 0.4)
            if (!r.ok) return { ok: false, error: r.error }
            return { ok: true, action, reply: r.content }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 settings|status|vision-test|style|chat' }
        }
      },
      // 通知（自研本地：配置存 server/notify.json；test 发送）
      async notify(args) {
        const action = str(args.action).trim()
        const cfgFile = 'C:/Mi/Ai/WorkBench/NiliX/server/notify.json'
        const read = async () => { try { return JSON.parse(await fread(cfgFile)) } catch (e) { return {} } }
        switch (action) {
          case 'get': return { ok: true, action, config: await read() }
          case 'set': {
            const cfg = await read()
            if (args.enabled !== undefined && args.enabled !== null) cfg.enabled = !!args.enabled
            for (const k of ['channel', 'endpoint', 'token', 'uid']) if (str(args[k])) cfg[k] = str(args[k])
            await fwrite(cfgFile, JSON.stringify(cfg, null, 2))
            return { ok: true, action, config: cfg }
          }
          case 'test': {
            const cfg = await read()
            const msg = str(args.message, '漫剧通知测试（来自 manju-flow 自研引擎）')
            const channel = str(cfg.channel)
            let sent = false, err = ''
            try {
              if (channel === 'serverchan' && cfg.token) {
                const r = await engine.httpPost('https://sctapi.ftqq.com/' + cfg.token + '.send', { title: '漫剧通知', desp: msg }, {}, 15000)
                sent = r.status === 200
              } else if (channel === 'pushplus' && cfg.token) {
                const r = await engine.httpPost('https://www.pushplus.plus/send', { token: cfg.token, title: '漫剧通知', content: msg }, {}, 15000)
                sent = r.status === 200
              } else if (channel === 'custom' && cfg.endpoint) {
                const r = await engine.httpPost(cfg.endpoint, { title: '漫剧通知', message: msg }, {}, 15000)
                sent = r.status === 200
              } else { err = '未配置渠道（channel/token/endpoint）或渠道不受支持: ' + channel }
            } catch (e) { err = String((e && e.message) || e) }
            return { ok: sent, action, sent, error: err || '', config: cfg }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 get|set|test' }
        }
      },
      // 项目与设置管理（自研本地：projects 扫目录 / create 本地建项目）
      async manage(args) {
        const action = str(args.action).trim()
        const project = str(args.project).trim()
        const manjuRoot = str(args.manjuRoot).trim() || await this.resolveManjuRoot()
        const cfgPath = project ? this.cfgPath(project, manjuRoot) : ''
        switch (action) {
          case 'projects': {
            const dirs = (await engine.listDir(manjuRoot)).filter((d) => d !== 'logs' && d !== 'ComfyUI' && d !== 'server' && d !== 'internal' && d !== 'web' && d !== 'docs' && d !== 'third_party' && d !== 'lhmsensor' && d !== 'manju')
            const projects = []
            for (const d of dirs) { const c = manjuRoot + '/' + d + '/config.json'; if (await fexists(c)) projects.push(d) }
            return { ok: true, action, projects, manjuRoot }
          }
          case 'find': {
            const novel = str(args.novel).trim()
            if (!novel) return { ok: false, error: '缺少 novel（小说路径）' }
            const dirs = (await engine.listDir(manjuRoot)).filter((d) => d !== 'logs')
            for (const d of dirs) {
              const c = manjuRoot + '/' + d + '/config.json'
              if (!(await fexists(c))) continue
              try { const cfg = JSON.parse(await fread(c)); if (cfg.paths && cfg.paths.novel && normPath(cfg.paths.novel) === normPath(novel)) return { ok: true, action, project: d, config: c } } catch (e) { /* ignore */ }
            }
            return { ok: true, action, project: null, note: '未找到引用该小说的项目' }
          }
          case 'create': {
            const name = str(args.name).trim()
            const novel = str(args.novel).trim()
            if (!name || !novel) return { ok: false, error: '缺少 name（剧名）/ novel（小说路径）' }
            if (!(await fexists(novel))) return { ok: false, error: '小说文件不存在: ' + novel }
            const workdir = manjuRoot + '/' + name
            await engine.fmkdir(workdir)
            await engine.fmkdir(workdir + '/analysis')
            await engine.fmkdir(workdir + '/assets/characters')
            await engine.fmkdir(workdir + '/assets/scenes')
            await engine.fmkdir(workdir + '/clips')
            const cfg = engine.defaultRender()
            cfg.style = str(args.style, 'real')
            cfg.llm = Object.assign({}, DEEPSEEK_DEF, { api_key: str(args.apiKey) })
            if (!cfg.llm.api_key) { try { const k = JSON.parse(await fread(NILIX_SERVER_CFG)); if (k.api_key) cfg.llm.api_key = k.api_key } catch (e) { /* ignore */ } }
            cfg.paths = { workdir, novel: normPath(novel), novel_dir: normPath(nodePath.dirname(novel)), analysis: workdir + '/analysis', assets: workdir + '/assets', clips: workdir + '/clips', comfy_input: COM_INPUT_DEF, comfy_output: COM_OUTPUT_DEF, outline: '', setting: '' }
            cfg.moderation = { banned_words: [], mosaic_enabled: false, mosaic_level: 16 }
            cfg.knowledge = {}
            await fwrite(workdir + '/config.json', JSON.stringify(cfg, null, 2))
            return { ok: true, action, project: name, config: workdir + '/config.json', note: '本地项目已创建（config 含默认渲染参数）' }
          }
          case 'delete': {
            if (!project) return { ok: false, error: '缺少 project' }
            const workdir = this.projectDir(cfgPath)
            if (!(await fexists(workdir))) return { ok: false, error: '项目目录不存在: ' + workdir }
            await engine.pwsh(`Remove-Item -LiteralPath '${workdir}' -Recurse -Force`, { strict: true })
            return { ok: true, action, project, deleted: workdir }
          }
          case 'project': {
            if (!project) return { ok: false, error: '缺少 project' }
            if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在' }
            try { const cfg = JSON.parse(await fread(cfgPath)); return { ok: true, action, project, config: cfgPath, cfg } } catch (e) { return { ok: false, error: '解析失败: ' + e.message } }
          }
          case 'settings': return { ok: true, action, note: '自研引擎：无服务端设置；DeepSeek key 存 config.llm.api_key 或 server/settings.json', settingsFile: NILIX_SERVER_CFG }
          case 'settings-set': return { ok: true, action, note: '自研引擎：设置存 server/settings.json（api_key）' }
          case 'paths': return { ok: true, action, effective: { manju_root: manjuRoot, novel_root: NOVEL_ROOT, comfy_url: COM_URL_DEF, comfy_input: COM_INPUT_DEF, comfy_output: COM_OUTPUT_DEF } }
          case 'paths-post': {
            // 保存部署路径：写 server/paths.json（自研引擎读取）
            const p = 'C:/Mi/Ai/WorkBench/NiliX/server/paths.json'
            let cur = {}
            try { cur = JSON.parse(await fread(p)) } catch (e) { /* ignore */ }
            const map = { manjuRootPost: 'manju_root', novelRootPost: 'novel_root', comfyRootPost: 'comfy_root', comfySharedPost: 'comfy_shared', novelSkillPost: 'novel_skill', comfyOutputPost: 'comfy_output' }
            for (const k of Object.keys(map)) if (has(args[k])) cur[map[k]] = str(args[k])
            await fwrite(p, JSON.stringify(cur, null, 2))
            return { ok: true, action, saved: cur }
          }
          case 'skill-update': return { ok: false, action, error: '技能更新走 git pull（原 NiliX 能力）；自研引擎不自动更新技能' }
          case 'render-save': {
            if (!project) return { ok: false, error: '缺少 project' }
            if (!(await fexists(cfgPath))) return { ok: false, error: 'config.json 不存在' }
            let cfg
            try { cfg = JSON.parse(await fread(cfgPath)) } catch (e) { return { ok: false, error: '解析失败: ' + e.message } }
            if (has(args.style)) cfg.style = str(args.style)
            cfg.render = Object.assign(engine.defaultRender(), cfg.render || {})
            if (args.width !== undefined && args.width !== null) cfg.render.width = align32(num(args.width, 768))
            if (args.height !== undefined && args.height !== null) cfg.render.height = align32(num(args.height, 1344))
            for (const [camel, snake] of [['fps', 'fps'], ['steps', 'steps'], ['turboSteps', 'turbo_steps'], ['seed', 'seed'], ['minShotSeconds', 'min_shot_seconds'], ['maxShotSeconds', 'max_shot_seconds'], ['shotsPerTake', 'shots_per_take']]) if (args[camel] !== undefined && args[camel] !== null) cfg.render[snake] = num(args[camel], 0)
            for (const [camel, snake] of STR_MAP) if (has(args[camel])) cfg.render[snake] = str(args[camel])
            for (const [camel, snake] of [['sageAttention', 'sage_attention'], ['draftJudge', 'draft_judge'], ['fl2vaEndFrame', 'fl2va_end_frame']]) if (args[camel] !== undefined && args[camel] !== null) cfg.render[snake] = !!args[camel]
            if (args.draftScale !== undefined && args.draftScale !== null) cfg.render.draft_scale = num(args.draftScale, 0.5)
            await fwrite(cfgPath, JSON.stringify(cfg, null, 2))
            return { ok: true, action, project, config: cfgPath, h3Compliance: h3ComplianceOf(cfg.render) }
          }
          case 'novel-save': {
            const text = str(args.text).trim()
            if (!text) return { ok: false, error: '缺少 text（小说正文）' }
            const title = str(args.title, '未命名小说')
            const dir = NOVEL_ROOT + '/' + title + '/全本'
            await engine.fmkdir(dir)
            const f = dir + '/' + title + '·全本.md'
            await fwrite(f, text)
            return { ok: true, action, saved: f }
          }
          case 'novel-info': {
            const novel = str(args.novel).trim() || (cfgPath ? ((() => { try { const c = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8')); return c.paths && c.paths.novel } catch (e) { return '' } })()) : '')
            if (!novel) return { ok: false, error: '缺少 novel 路径或 project' }
            if (!(await fexists(novel))) return { ok: false, error: '文件不存在: ' + novel }
            const text = await fread(novel)
            const chaps = (text.match(/第\d+章/g) || []).length
            return { ok: true, action, novel, chapters: chaps || '?', chars: text.length }
          }
          case 'env': {
            const comfy = engine.comfyClient(COM_URL_DEF)
            const c = await comfy.online()
            const ff = await fexists(FFMPEG_DIR_DEF + '/ffmpeg.exe')
            return { ok: true, action, env: {
              comfy: { online: !!c.online, comfyui_version: str(c.comfyui_version), device: str(c.device), vram_total: num(c.vram_total, 0) }, ffmpeg: ff, novelRoot: NOVEL_ROOT, manjuRoot, engine: '自研（零 NiliX）',
              niliX: await (async () => { try { const r = await engine.httpGet('http://127.0.0.1:8787/', 3000); return r.status === 200 } catch (e) { return false } })(),
            } }
          }
          case 'models': return { ok: true, action, note: '自研引擎：模型名在 config.render（unet_fl2va/unet_ref2va/clip/vae_video/vae_audio/z_image_*/turbo_lora）' }
          case 'output-delete': {
            if (!project) return { ok: false, error: '缺少 project' }
            const scope = str(args.scope).trim()
            if (scope !== 'file' && scope !== 'episode') return { ok: false, error: '缺少 scope（file|episode）' }
            const workdir = this.projectDir(cfgPath)
            if (scope === 'file') {
              const p = str(args.path).trim()
              if (!p) return { ok: false, error: '缺少 path（文件绝对路径，须在项目 workdir 内）' }
              if (normPath(p).indexOf(normPath(workdir)) !== 0) return { ok: false, error: '路径不在项目 workdir 内' }
              if (!(await fexists(p))) return { ok: false, error: '文件不存在: ' + p }
              await engine.fremove(p)
              return { ok: true, action, deleted: p }
            }
            const ep = str(args.episode, 'EP01')
            const dir = workdir + '/clips/' + ep
            if (await fexists(dir)) { await engine.pwsh(`Remove-Item -LiteralPath '${dir}' -Recurse -Force`, { strict: true }); return { ok: true, action, deleted: dir } }
            return { ok: true, action, note: '目录不存在（无产物）: ' + dir }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 projects|find|create|delete|project|settings|settings-set|paths|paths-post|skill-update|render-save|novel-save|novel-info|env|models|output-delete' }
        }
      },
      // 剧本生成（自研本地：DeepSeek 直出分镜脚本，供预览/诊断）
      async script(args) {
        const action = str(args.action).trim()
        switch (action) {
          case 'generate': {
            const novel = str(args.novel).trim()
            if (!novel) return { ok: false, error: '缺少 novel（小说路径）' }
            if (!(await fexists(novel))) return { ok: false, error: '文件不存在: ' + novel }
            const style = str(args.style, 'real')
            const cfg = { llm: {} }
            const llm = await engine.loadLLM(cfg)
            const text = (await fread(novel)).slice(0, 8000)
            const sd = engine.styleDesc(style)
            const sys = `你是资深 AI 视频导演。根据小说生成一集 MiniMax H3 分镜脚本。必须只输出合法 JSON：{"title":"标题","characters":[{"name":"角色名","role":"主角/反派/配角","description":"外貌/服装/性格"}],"scenes":[{"name":"场景名","description":"环境/光线/氛围"}],"shots":[{"id":"S01","duration_sec":6,"hook":"setup/reveal/reversal/suspense/tender/climax","continuity":"衔接说明","description":"景别/运镜/动作","h3_prompt":"完整 H3 提示词（英文，含 integrated_multimodal_description / overall_soundscape / non_diegetic_music 三段；台词 <d>[中文]原文</d>）"}]}。单集 3-8 镜头，每镜 4-12 秒。视觉风格统一为：${sd.asset}`
            const r = await engine.llmJSON(llm, sys, text, { maxTokens: 16384 })
            if (!r.ok) return { ok: false, error: r.error }
            return { ok: true, action, script: r.data }
          }
          case 'styles': return { ok: true, action, styles: H3_STYLES.map((s) => ({ id: s, name: s })) }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 generate|styles' }
        }
      },
      // 旧渲染任务诊断（自研本地：读取 NiliX 旧产物目录结构）
      async renderJobs(args) {
        const action = str(args.action).trim()
        switch (action) {
          case 'list': {
            const dirs = (await engine.listDir(MANJU_SELF)).filter((d) => d !== 'logs')
            const jobs = []
            for (const d of dirs) {
              const r = await engine.readState(MANJU_SELF + '/' + d)
              jobs.push({ id: d, title: d, status: r.running ? 'running' : (r.done ? 'done' : 'idle'), stage: r.stage || '', error: r.error || '' })
            }
            return { ok: true, action, jobs, note: '自研引擎：读本地 run_state.json（旧 NiliX 目录只读诊断）' }
          }
          case 'status': {
            const id = str(args.id).trim()
            if (!id) return { ok: false, error: '缺少 id（任务 id）' }
            const r = await engine.readState(MANJU_SELF + '/' + id)
            return { ok: true, action, id, status: r }
          }
          case 'outputs': {
            const clips = MANJU_SELF + '/clips'
            const out = []
            if (await fexists(clips)) for (const d of await engine.listDir(clips)) { const files = await engine.listFiles(clips + '/' + d, '*.mp4'); for (const f of files) out.push(f) }
            return { ok: true, action, outputs: out }
          }
          default: return { ok: false, error: '未知 action: ' + action + '；可选 list|status|outputs' }
        }
      },
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M3 编排域（一条龙计划）
    // ═══════════════════════════════════════════════════════════════════════
    const pipeline = {
      plan(args) {
        const target = str(args.target, 'video')
        const steps = []
        if (target === 'novel' || target === 'video') {
          steps.push(
            { step: 1, module: 'M1', phase: '立项+脚手架', tool: 'manju_novel_scaffold', args: { project: str(args.project), genre: str(args.genre), style: str(args.style), chapters: num(args.chapters, 56) }, note: '建目录/复制模板/写立项.json（幂等）' },
            { step: 2, module: 'M1', phase: '设定集与大纲', tool: 'write 或 manju_novel_web create', args: {}, note: '写 设定集/设定集与大纲.md（人物含写实电影级英文提示词/世界观含灵力等级/金手指含代价/分章大纲）；或 manju_novel_web create 让 NiliX LLM 直出；建 正文/卷X_卷名 目录' },
            { step: 3, module: 'M1', phase: '并行写章', tool: 'manju_novel_dispatch × 卷数 + subagent（或 manju_novel_web auto）', args: {}, note: '对每卷调 dispatch 取派发 prompt → 并行派写章子代理（先读规范/速查卡/违规词库；章节名唯一；1400-1550字）' },
            { step: 4, module: 'M1', phase: 'QA', tool: 'manju_novel_qa', args: {}, note: '全量校验；不达标修复重跑' },
            { step: 5, module: 'M1', phase: '封面', tool: 'manju_novel_cover', args: {}, note: '先写 封面/pos.txt（写实电影级）；glm-image 云端默认，zimage 本地' },
            { step: 6, module: 'M1', phase: '素材导出', tool: 'manju_novel_materials', args: {}, note: '设定集 → 素材/人物生成提示词.md + 素材/场景提示词.md（NiliX scanNovelAssets 直用；旧文件备份）' },
            { step: 7, module: 'M1', phase: '全本合并', tool: 'manju_novel_assemble', args: {}, note: '全本/<书名>·全本.md（NiliX paths.novel 正文源）' },
          )
        }
        if (target === 'render' || target === 'video') {
          const base = target === 'render' ? 1 : 8
          steps.push(
            { step: base, module: 'M2', phase: '渲染配置', tool: 'manju_render_config', args: { project: str(args.project) }, note: '生成 NiliX config.json（全本路径/DeepSeek key 自动；保留已有渲染参数；宽高自动 32 倍数对齐）' },
            { step: base + 1, module: 'M2', phase: '平台体检', tool: 'manju_render_health', args: {}, note: 'NiliX(8787) 与 ComfyUI 就绪；可 fix；ComfyUI 离线可 manju_render_comfy start；含 h3Compliance 摘要' },
            { step: base + 2, module: 'M2', phase: '方案 plan', tool: 'manju_render_run', args: { phase: 'plan' }, note: 'LLM 直出分镜/角色/场景/H3 提示词（episode 0=全本自动分集）' },
            { step: base + 3, module: 'M2', phase: '资产 assets', tool: 'manju_render_run', args: { phase: 'assets' }, note: '定妆照/场景图（素材提示词已就位，定妆照=Ref2VA <Picture N> 身份源）；不满意可 manju_render_gacha 抽卡换装' },
            { step: base + 4, module: 'M2', phase: '编码 encode', tool: 'manju_render_run', args: { phase: 'encode' }, note: 'Qwen3-VL 条件缓存 .pt' },
            { step: base + 5, module: 'M2', phase: '渲染 render', tool: 'manju_render_run', args: { phase: 'render' }, note: '逐镜 H3 生成（每镜 4-5 分钟；用 status 轮询）' },
            { step: base + 6, module: 'M2', phase: '质检 qc', tool: 'manju_render_run', args: { phase: 'qc' }, note: '机械质检 + 审片判分；失败镜头自动重渲；需要人工决策用 manju_render_qc' },
            { step: base + 7, module: 'M2', phase: '合成 assemble', tool: 'manju_render_run', args: { phase: 'assemble' }, note: '成片 <ep>_成片.mp4（转场/字幕/BGM/马赛克）' },
            { step: base + 8, module: 'M2', phase: '后处理（可选）', tool: 'manju_render_post', args: {}, note: 'upscale2k 云端2K / jianying 剪映导出 / trailer 预告片' },
          )
        }
        return {
          ok: true, target, book: str(args.project), stepCount: steps.length, steps,
          tips: [
            '渲染阶段全部异步：run 启动后调 manju_render_status 轮询（status.running/stage/agent）',
            'phase=all 一条龙顺序执行；agent=true 走 AI 智能体调度（审片自动返工）',
            '集数语义：episode N = 第 N 章（1章1集）；0 = 全本自动分集；断点续跑幂等',
            'H3 合规：短边 ≤768 且 32 倍数；风格 8 预设可 + 组合或英文自定义；定妆照即 Ref2VA <Picture N> 身份源，跨镜外观逐字一致',
            '平台管理：manju_render_comfy 管 ComfyUI；manju_render_notify 配通知；manju_render_manage 管项目/设置/环境；manju_novel_web 走 NiliX 网页版创作',
          ],
        }
      },
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 工具注册（21 个）
    // ═══════════════════════════════════════════════════════════════════════
    const TOOL_DEFS = [
      tool('manju_novel_scaffold', '小说立项+脚手架（shuangwen-novel 阶段0-1）：建 设定集/正文/素材/封面/全本 目录，复制 创作指令卡 与 章节写作规范 模板（已存在不覆盖），写 立项.json（幂等：已有且未改章节数则复用）。', { project: S('书名（必填）'), genre: S('题材，如 都市/玄幻/系统流，可组合'), style: S('风格，如 写实/热血/爽文'), chapters: I('章节数，默认 56（硬下限 52）'), root: S('小说库根目录，默认 C:/Mi/Ai/WorkBench/novel') }, ['project'], (a) => novel.scaffold(a)),
      tool('manju_novel_dispatch', '生成指定卷的写章代理派发 prompt：读取 设定集/设定集与大纲.md 对应卷大纲行，填充代理派发模板（含必读规范/字数/章节名唯一/衔接要求）。把返回的 prompt 原文作为写章子代理输入。', { project: S('书名（必填）'), volume: S('卷号：数字 1..N 或卷名，如 3 / 卷三（必填）'), root: S('小说库根目录（默认自动解析）') }, ['project', 'volume'], (a) => novel.dispatch(a)),
      tool('manju_novel_qa', '运行 qa_check.py 全量校验：文件数/每章字数(≥1280)/20个禁用词/违规词(动态库)/正文加粗，并复检 章节名重名 与 末章（全书完）标记。exitCode 2=FAIL。', { project: S('书名（必填）'), strict: B('字数超上限时也 FAIL（默认仅提示）'), root: S('小说库根目录（默认自动解析）') }, ['project'], (a) => novel.qa(a)),
      tool('manju_novel_cover', '生成写实电影级封面：先写 封面/pos.txt（正向，可加 封面/neg.txt），默认 glm-image 云端（0.1元/次，免本地），zimage/sdxl 走本地 ComfyUI。产出 封面/封面.png。', { project: S('书名（必填）'), model: S('glm-image|zimage|sdxl（默认 glm-image）'), seed: I('随机种子'), negBank: S('负面词库分类（默认 通用禁日漫风），可逗号多选'), root: S('小说库根目录（默认自动解析）') }, ['project'], (a) => novel.cover(a)),
      tool('manju_novel_materials', '素材导出（shuangwen-novel 阶段6 重构版）：从 设定集/设定集与大纲.md 抽取人物与场景，生成 素材/人物生成提示词.md 与 素材/场景提示词.md——按 NiliX scanNovelAssets 规格产出（CharPrompt/ScenePrompt 直接注入 plan 系统提示词）。覆盖前自动备份旧文件 .bak-*。返回缺英文提示词的角色清单。', { project: S('书名（必填）'), root: S('小说库根目录（默认自动解析）') }, ['project'], (a) => novel.materials(a)),
      tool('manju_novel_assemble', '全本合并：运行 assemble_full.py（按章号数字排序，防中文卷名乱序）生成 全本/<书名>·全本.md——NiliX config.paths.novel 的正文源。', { project: S('书名（必填）'), root: S('小说库根目录（默认自动解析）') }, ['project'], (a) => novel.assemble(a)),
      tool('manju_novel_web', 'NiliX 网页版小说创作（shuangwen-novel 流程固化，LLM 直出）：create 立项生成设定集与大纲（同步30-90s，幂等）/ chapter 逐章生成（≥1280字，幂等）/ review 评章（8维打分）/ analyze 策划分析 / progress 进度 / auto 后台自动连载 / auto-stop / auto-status / status-all。', { action: S('create|chapter|review|analyze|progress|auto|auto-stop|auto-status|status-all（必填）'), title: S('书名（create/chapter/review/progress/auto 用）'), genre: S('题材（create/analyze 用）'), style: S('风格（create/analyze 用）'), chapters: I('章数（create 用，默认 56，硬下限 52）'), no: I('章号（chapter/review 用）') }, ['action'], (a) => novel.web(a)),
      tool('manju_render_config', '生成/更新漫剧项目 config.json（自研引擎，零 NiliX）：自动解析小说正文（优先 全本/<书名>·全本.md）、DeepSeek key（显式 > 项目已有 > server/settings.json）、manju 根目录、Comfy 目录；渲染参数保留项目已有值（仅显式传参覆盖）；宽高自动 32 倍数对齐（H3 VAE 网格）；返回 h3Compliance 合规摘要与风格提示。', { project: S('书名=剧名（必填）'), style: S('渲染风格：2.5d/real/3d/anime/handdrawn/papercraft/clay/ink 或 + 组合或英文自定义，默认 real'), width: I('宽（默认 768，自动对齐 32 倍数）'), height: I('高（默认 1344，自动对齐 32 倍数）'), fps: I('帧率（默认 24）'), steps: I('采样步数（默认 20）'), turboSteps: I('turbo 步数（默认 8）'), seed: I('种子（默认 1688）'), episode: S('默认集数：0=全本默认（默认）；N=第N章'), chapters: S('默认章节范围（空=全部）'), resTier: S('分辨率档位 draft|standard|fhd'), transition: S('转场 cut|fade|dissolve'), bgm: S('BGM 路径'), seedPolicy: S('seed 策略 fixed|increment|random'), sageAttention: B('SageAttention 加速'), draftJudge: B('草稿预审'), draftScale: S('草稿缩放 0.2-0.95'), turboLoraR2v: S('Ref2VA 专用 Turbo LoRA（默认同 turbo_lora）'), fl2vaEndFrame: B('空镜 FL2VA 尾帧锚定（默认关；开=场景图双帧防段尾漂移，成本翻倍）'), llmApiKey: S('DeepSeek key（默认读 server/settings.json）'), llmModel: S('LLM 模型（默认 deepseek-chat）'), manjuRoot: S('漫剧项目根目录（默认自动解析）'), novelRoot: S('小说库根目录（默认自动解析）') }, ['project'], (a) => render.config(a)),
      tool('manju_render_health', '平台可用性 + 项目体检（自研引擎：ComfyUI 直连检测 + 本地 config 体检/H3 合规/风格校验）。fix=true 本地一键修复（llm_key/h3 宽高）。ComfyUI 未运行返回 platform=down。', { project: S('剧名（可空=仅平台检测）'), fix: B('一键修复体检项'), key: S('指定修复项 key（留空=全部可修复项）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, [], (a) => render.health(a)),
      tool('manju_render_run', '执行渲染阶段（自研引擎本地异步：plan 方案 / assets 资产 / encode 预编码(并入 render) / render 逐镜 H3 / qc 质检 / assemble 合成 / all 一条龙。直连 ComfyUI+DeepSeek，零 NiliX；异步启动立即返回，用 manju_render_status 轮询）。', { project: S('剧名（必填）'), phase: S('plan|assets|encode|render|qc|assemble|all（必填）'), episode: I('集数：0=全本默认（用 config）；N=第N章=第N集'), only: S('定点镜头，逗号分隔，如 1,2（仅 render/qc 有效）'), fresh: B('重跑：清空旧产物'), agent: B('AI 一条龙（自研引擎暂以本地机械质检代替 VLM 判分）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project', 'phase'], (a) => render.run(a)),
      tool('manju_render_status', '轮询渲染状态（自研引擎本地：run_state.json 的 running/stage/shot 进度 + clips 产物清单 + 方案摘要 + run.log 尾部）。渲染阶段每几分钟调一次。', { project: S('剧名（必填）'), tailLines: I('run.log 尾部行数（默认 30）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project'], (a) => render.status(a)),
      tool('manju_render_post', '渲染后处理：upscale2k 云端2K升级（0.8元/秒，先 estimate 看费用）/ jianying 剪映草稿导出 / trailer 预告片（默认30s）/ cleanup 清理抽卡候选与临时产物 / cleanup-sizes 各目录占用。', { project: S('剧名（必填）'), action: S('upscale2k|upscale2k-estimate|jianying|trailer|cleanup|cleanup-sizes（必填）'), episode: S('集号（默认 EP01）'), shots: S('upscale 定点镜头，逗号分隔'), target: I('预告片秒数 10-120（默认 30）'), targets: S('cleanup 目标，逗号分隔 gacha,frames,2k'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project', 'action'], (a) => render.post(a)),
      tool('manju_render_kill', '停止当前渲染任务（自研引擎：置 stopped 标记 + ComfyUI /interrupt，纯本地）。', { project: S('剧名（必填）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project'], (a) => render.kill(a)),
      tool('manju_render_comfy', 'ComfyUI 管理：status 状态 / start 启动（自动等待就绪）/ stop 停止 / install 一键安装 / install-status 安装进度 / install-stop 停止安装。渲染前置保障。', { action: S('status|start|stop|install|install-status|install-stop（必填）') }, ['action'], (a) => render.comfy(a)),
      tool('manju_render_gacha', '角色抽卡（定妆照换装，2026-08-24 支持视图）：draw 随机生成候选（需 plan 已出角色；view=front/full/side/detail/q，空=主图；q 仅正角）/ adopt 采纳候选为正式定妆照（覆盖→指纹失效→自动重渲）/ upload 上传图片直接采纳（本地路径）/ plan LLM 直出角色方案。', { project: S('剧名（必填）'), action: S('draw|adopt|upload|plan（必填）'), char: S('角色名（须在方案 characters 中）'), view: S('视图：front/full/side/detail/q（draw/adopt/upload 用；空=主视图；q 仅正角）'), image: S('本地图片绝对路径（adopt 候选图 / upload 上传图，png/jpg/webp ≤20MB）'), chapters: S('章节范围（plan 用）'), episode: S('集号（默认 EP01）'), shots: S('镜头筛选（plan 用）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project', 'action'], (a) => render.gacha(a)),
      tool('manju_render_qc', '质检决策与重审：decision 逃生门（skip=跳过失败镜并续跑，accept=接受坏镜进成片；直接写 config.render） / judge 单镜手动重审（VLM 判分）/ resolve 升级例外处理（retry 定点返工 | ignore 接受现状）。', { project: S('剧名（必填）'), action: S('decision|judge|resolve（必填）'), skip: S('decision: 跳过镜头号逗号分隔，如 3,7'), accept: B('decision: 接受质检结果（失败不阻断）'), shot: I('judge/resolve: 镜头号'), decision: S('resolve: retry|ignore'), episode: S('集号（默认 EP01）'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project', 'action'], (a) => render.qc(a)),
      tool('manju_render_agent', 'AI 智能体管理：settings 配置视觉判分模型（enabled/visionBaseUrl/visionApiKey/visionModel/passScore/maxRetries/judgeConcurrency/autoResolve/minimaxApiKey；global=true 存全局默认）/ status 审片状态与配置 / vision-test 视觉模型连通测试 / style 深度分析推荐风格 / chat 自然语言指令。', { project: S('剧名（必填）'), action: S('settings|status|vision-test|style|chat（必填）'), enabled: B('settings: 启用智能体'), visionBaseUrl: S('settings: 视觉模型地址'), visionApiKey: S('settings: 视觉模型 Key'), visionModel: S('settings: 视觉模型名'), passScore: S('settings: 及格线 0-100'), maxRetries: I('settings: 返工轮数 0-4'), judgeConcurrency: I('settings: 判分并发 1-4'), autoResolve: B('settings: 预算耗尽自动拍板'), minimaxApiKey: S('settings: 云端2K Key'), global: B('settings: true=另存为全局默认'), text: S('chat: 自然语言指令（如“分析当前项目并给出下一步”）'), chapters: S('style: 章节范围'), novel: S('style: 小说路径覆盖'), episode: S('style: 集号'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['project', 'action'], (a) => render.agent(a)),
      tool('manju_render_notify', '通知配置：get 读取 / set 设置（channel=serverchan|pushplus|wecom|wxpusher|custom；enabled/endpoint/token/uid）/ test 发送测试消息。渲染完成/失败推送。', { action: S('get|set|test（必填）'), channel: S('set: 渠道 serverchan|pushplus|wecom|wxpusher|custom'), enabled: B('set: 启用通知'), endpoint: S('set: 自定义 endpoint（wecom/custom 用）'), token: S('set: 渠道 token/secret'), uid: S('set: wxpusher UID（逗号分隔）'), message: S('test: 测试消息内容') }, ['action'], (a) => render.notify(a)),
      tool('manju_render_manage', 'NiliX 项目与设置管理：projects 项目列表 / find 按小说查项目 / create 建项目（name+novel+apiKey）/ delete 删项目 / project 项目配置 / settings 默认Key·服务 / settings-set 保存默认Key·服务 / paths 部署路径生效值 / paths-post 保存部署路径 / skill-update 更新小说技能 / render-save 保存渲染配置 / novel-save 粘贴正文存 .md / novel-info 小说章节统计 / env 环境自检 / models 模型候选 / output-delete 删产物（file|episode）。', { action: S('projects|find|create|delete|project|settings|settings-set|paths|paths-post|skill-update|render-save|novel-save|novel-info|env|models|output-delete（必填）'), project: S('剧名（大部分 action 需要）'), name: S('create: 剧名'), novel: S('create/find/novel-info: 小说路径'), apiKey: S('create/settings-set: DeepSeek key'), baseUrl: S('settings-set: 默认服务地址'), model: S('settings-set: 默认模型'), clear: S('settings-set: 清除=1'), manjuRootPost: S('paths-post: manju 根目录'), novelRootPost: S('paths-post: novel 根目录'), comfyRootPost: S('paths-post: Comfy 安装目录'), comfySharedPost: S('paths-post: Comfy 共享目录'), novelSkillPost: S('paths-post: 技能目录'), comfyOutputPost: S('paths-post: Comfy 成品输出目录'), text: S('novel-save: 小说正文'), title: S('novel-save: 标题'), style: S('render-save: 风格'), scope: S('output-delete: file|episode'), path: S('output-delete file: 文件绝对路径（须在项目 workdir 内）'), width: I('render-save: 宽'), height: I('render-save: 高'), fps: I('render-save: 帧率'), steps: I('render-save: 步数'), turboSteps: I('render-save: turbo 步数'), seed: I('render-save: 种子'), minShotSeconds: I('render-save: 最短镜头秒'), maxShotSeconds: I('render-save: 最长镜头秒'), shotsPerTake: I('render-save: 每镜切点数 1-3'), comfyUrl: S('render-save: Comfy 地址'), negPrompt: S('render-save: 负面提示词'), fl2vaEndFrame: B('render-save: 空镜 FL2VA 尾帧锚定'), unetFl2va: S('render-save: FL2VA UNET'), unetRef2va: S('render-save: Ref2VA UNET'), clip: S('render-save: CLIP'), vaeVideo: S('render-save: 视频 VAE'), vaeAudio: S('render-save: 音频 VAE'), zImageUnet: S('render-save: Z-Image UNET'), zImageClip: S('render-save: Z-Image CLIP'), zImageVae: S('render-save: Z-Image VAE'), turboLora: S('render-save: Turbo LoRA'), turboLoraR2v: S('render-save: Ref2VA 专用 Turbo LoRA'), animagineCkpt: S('render-save: SDXL checkpoint'), resTier: S('render-save: 分辨率档位'), transition: S('render-save: 转场'), bgm: S('render-save: BGM'), seedPolicy: S('render-save: seed 策略'), sageAttention: B('render-save: SageAttention'), draftJudge: B('render-save: 草稿预审'), draftScale: S('render-save: 草稿缩放 0.2-0.95'), episode: S('output-delete episode / 集号'), manjuRoot: S('漫剧项目根目录（默认自动解析）') }, ['action'], (a) => render.manage(a)),
      tool('manju_render_script', '剧本生成（NiliX storyboard 一集视频脚本）：generate 输入小说路径+风格生成一集脚本 / styles 可选风格列表。注：主渲染管线为 manju，本工具供剧本预览/诊断。', { action: S('generate|styles（必填）'), novel: S('generate: 小说路径'), style: S('generate: 风格（可空）') }, ['action'], (a) => render.script(a)),
      tool('manju_render_jobs', '旧渲染任务（只读诊断，主管线为 manju）：list 任务列表 / status 单任务状态（id）/ outputs 成品列表。', { action: S('list|status|outputs（必填）'), id: S('status: 任务 id') }, ['action'], (a) => render.renderJobs(a)),
      tool('manju_pipeline_plan', '生成「小说→视频」整条流水线的执行计划：依赖有序步骤清单（每步标注模块/工具/参数/说明）。target=video 全流程；novel 只到小说；render 只走渲染。按 steps 逐条执行即完成一条龙直出。', { project: S('书名/剧名'), target: S('video|novel|render（默认 video）'), genre: S('题材'), style: S('风格'), chapters: I('章节数（默认 56）') }, [], (a) => pipeline.plan(a)),
    ]

    const disposers = []
    for (const def of TOOL_DEFS) {
      try {
        const d = ctx.tools.register(def)
        if (typeof d === 'function') disposers.push(d)
        log('tool registered:', def.name)
      } catch (e) { log('tool register failed:', def.name, e && e.message) }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M4 面板域 — manjuConsole Remote 服务 + typert contribution
    // Client 面板经 ctx.remote.manjuConsole.* 调用；全部箭头函数，this 无关；
    // 方法直接复用 M1/M2/M3 业务实现，面板零重复逻辑。
    // ═══════════════════════════════════════════════════════════════════════
    const manjuConsole = {
      platform: async () => {
        // 自研引擎：ComfyUI 直连检测（无 NiliX）
        const comfy = engine.comfyClient(COM_URL_DEF)
        const c = await comfy.online()
        return { up: c.online, comfy: c.online, engine: '自研（零 NiliX）', comfyInfo: c }
      },
      projects: async () => {
        const r = await render.manage({ action: 'projects' })
        return { projects: (r && r.projects) || [] }
      },
      status: async (a) => render.status(Object.assign({ tailLines: 30 }, a || {})),
      health: async (a) => render.health(a || {}),
      config: async (a) => render.config(a || {}),
      run: async (a) => render.run(a || {}),
      kill: async (a) => render.kill(a || {}),
      post: async (a) => render.post(a || {}),
      comfy: async (a) => render.comfy(a || {}),
      create: async (a) => render.manage(Object.assign({}, a || {}, { action: 'create' })),
      gacha: async (a) => render.gacha(a || {}),
      qc: async (a) => render.qc(a || {}),
      agent: async (a) => render.agent(a || {}),
      notify: async (a) => render.notify(a || {}),
      manage: async (a) => render.manage(a || {}),
      plan: async (a) => pipeline.plan(a || {}),
    }
    ctx.provide('manjuConsole', manjuConsole)
    log('service provided: manjuConsole')

    // typert contribution：Client 端 $mount 的 descriptors 必须与本清单一致
    //（id 全局唯一；namespace/method 即 gateway endpoint <ns>/<method>）
    // ★ 2026-08-24 修复：codec 必须 mode:"strict" + typeSymbol + schema.parse——
    //   旧格式 { mode:'src-json' } 被 client api-gateway requireStrictCodec 拒绝 →
    //   $mount 失败 → 面板 Remote 调用全部降级。schema 用 passthrough（语义=JSON 透传，
    //   api-gateway 只调用 codec.schema.parse(value)）。
    const passthrough = (typeSymbol) => ({ parse(value) { return value }, _schemaType: typeSymbol })
    const ARGS_SCHEMA = passthrough('manju-flow#manjuConsole/args')
    const ANY_SCHEMA = passthrough('any')
    const INVOCATIONS = []
    const INV_METHODS = ['platform', 'projects', 'status', 'health', 'config', 'run', 'kill', 'post', 'comfy', 'create', 'gacha', 'qc', 'agent', 'notify', 'manage', 'plan']
    for (const m of INV_METHODS) {
      INVOCATIONS.push({
        id: 'manju-flow#manjuConsole/' + m,
        service: 'manjuConsole',
        namespace: 'manjuConsole',
        method: m,
        invocation: { kind: 'direct' },
        parameters: (m === 'platform' || m === 'projects') ? [] : [{
          name: 'args', wire: 'args', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'manju-flow#manjuConsole/args', schema: ARGS_SCHEMA },
        }],
        result: { mode: 'strict', typeSymbol: 'manju-flow#manjuConsole/' + m + ':result', schema: ANY_SCHEMA },
      })
    }
    const typertSvc = ctx.get('typert')
    if (typertSvc) {
      try {
        const d = typertSvc.register({
          package: 'manju-flow',
          face: 'host',
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: INVOCATIONS,
        })
        if (typeof d === 'function') disposers.push(d)
        log('typert registered:', INVOCATIONS.length, 'invocations')
      } catch (e) { log('typert register failed:', e && e.message) }
    } else {
      log('typert service unavailable; Remote 面板调用不可用')
    }

    ctx.on('dispose', () => { for (const d of disposers) { try { d() } catch (e) { /* ignore */ } } })
  },
}
