# 🎬 漫剧一条龙 Manju Flow

> **DSH（DeepSeek Harness）全功能插件**：承接 shuangwen-novel 爽文小说创作管线 + 自研 H3 漫剧渲染引擎，一条龙直出「小说 → 视频」。
>
> 用户只需说一句「写本爽文并渲染成视频」，即可自动完成：立项 → 设定集 → 并行写章 → QA 校验 → 封面 → 素材导出 → 全本 → 渲染方案 → 定妆照/场景图 → H3 逐镜渲染 → 质检 → 合成成片。

**v1.2.0（2026-08-24）升级**：对齐 NiliX 2026-08-24 最新实现 + 知识库 H3 规范，核心升级：
- **方案生成**：角色卡升级（`role` 阵营判定 + Q版纪律「仅正角」/ `views` 五视图 / 拟漫化 image_prompt / 面容独特性防跨剧撞脸 / 判停清单六类 / directing 防同质化五维 / 内心独白标记）
- **逐镜 H3 提示词**：Ref2VA 多视图 Subject（同角色多视图多 Picture）、拟漫化锚句、输出体积硬约束（1500 tokens）、28 条写作规则（状态变化画之前/描述零数字/缺席否定句列全/构图权重之争/概念盲区/内心戏Q版化/动物禁人脸等）
- **资产生成**：定妆固定 1024×1024（与画幅解耦）+ charSeed 稳定种子 + 五视图 img2img 保身份换视角 + Q版仅正角（反派/功能配角跳过）+ 场景强制空景无人+方形
- **渲染**：★ ref_images 平铺键修复（旧数组会被 ComfyUI 静默忽略 → 参考图丢失）、多视图参考选择（单角色3视图/双角色2视图）、内心戏镜 Q 版参考优先、条件缓存带项目前缀防跨项目串用、FL2VA 空镜尾帧锚定（可选）
- **质检**：亮度暗像素检测（黑屏兜底 >50% 判 FAIL）
- **Host/Client**：gacha 视图抽卡（front/full/side/detail/q）、config/render-save 新增 fl2vaEndFrame、health 权重完整性检查（音频 VAE 缺失=黑屏根因）

**零 NiliX 依赖**：渲染引擎完全自研，直连 ComfyUI(8190) 驱动 MiniMax H3 工作流 + DeepSeek(OpenAI 兼容) 出方案/提示词 + FFmpeg/ffprobe 本地合成/质检。

---

## ✨ 功能全景（22 个 manju_* 工具）

### M1 小说管线（shuangwen-novel 承接）
| 工具 | 功能 |
|---|---|
| `manju_novel_scaffold` | 立项+脚手架：建目录/复制模板/写立项.json（幂等） |
| `manju_novel_dispatch` | 卷派发 prompt：读大纲填充写章代理派发模板 |
| `manju_novel_qa` | 全量校验：文件数/每章字数(≥1280)/禁用词/违规词/加粗/章名重名/末章标记 |
| `manju_novel_cover` | 写实电影级封面（glm-image 云端默认，zimage/sdxl 本地） |
| `manju_novel_materials` | 素材导出：设定集 → 人物/场景英文提示词 md（渲染注入） |
| `manju_novel_assemble` | 全本合并：按章号数字排序生成 全本/<书名>·全本.md |
| `manju_novel_web` | NiliX 网页版小说创作（可选，需 NiliX） |

### M2 渲染管线（自研引擎，零 NiliX）
| 工具 | 功能 |
|---|---|
| `manju_render_config` | 生成/更新项目 config.json（小说解析/DeepSeek key/32 倍数对齐） |
| `manju_render_health` | 平台体检：ComfyUI 直连检测 + 本地 config 体检/H3 合规/一键修复 |
| `manju_render_run` | 阶段执行：plan / assets / encode / render / qc / assemble / all（本地异步） |
| `manju_render_status` | 状态轮询：run_state + 产物清单 + 方案摘要 + run.log 尾部 |
| `manju_render_kill` | 停止任务：stopped 标记 + ComfyUI /interrupt |
| `manju_render_comfy` | ComfyUI 管理：status / start / stop |
| `manju_render_gacha` | 角色抽卡：draw 候选 / adopt 采纳 / upload 上传 / plan LLM 方案（v1.2.0 支持视图 front/full/side/detail/q，Q版仅正角） |
| `manju_render_qc` | 质检决策：decision 逃生门 / judge 单镜重审(ffprobe) / resolve 返工 |
| `manju_render_agent` | 审片智能体：settings / status / style 分析 / chat 指令 |
| `manju_render_post` | 后处理：trailer 预告片 / cleanup 清理 / cleanup-sizes |
| `manju_render_notify` | 通知：serverchan / pushplus / wecom / custom |
| `manju_render_manage` | 项目与设置：projects / create / delete / render-save / env 等 |
| `manju_render_script` | 剧本生成（DeepSeek 直出分镜脚本，诊断用） |
| `manju_render_jobs` | 旧任务诊断（只读） |

### M3 编排
| 工具 | 功能 |
|---|---|
| `manju_pipeline_plan` | 16 步「小说→视频」一条龙计划 |

### 管理台 UI（Client）
侧栏输入框右侧 **🎬 按钮** → 7 标签管理台：
- **总览**：平台状态/项目选择/管线一键执行/日志
- **监控**：实时渲染进度条/镜头产物/日志滚动（3s 刷新）
- **小说**：小说库/创作管线指引
- **项目**：config 配置/ComfyUI 管理/环境自检
- **渲染**：阶段执行/抽卡/质检
- **风格**：8 预设风格/组合/自定义
- **设置**：智能体/通知/部署路径

---

## 🏗 架构

```
manju-flow-plugin/
├── index.js          Host 半边：22 个 manju_* 工具 + manjuConsole Remote 服务
│                     （工具注册 / M1 小说域 / M2 渲染域 / M3 编排域 / M4 面板域）
├── engine.js         自研渲染引擎（零 NiliX）：
│                     ComfyUI 直连(8190) / DeepSeek / FFmpeg / 工作流构建 /
│                     方案生成 / 资产（五视图）/ 逐镜渲染 / 合成质检 / 状态落盘
├── client.js         Client 半边：侧栏 🎬 按钮 + 7 标签管理台
├── cordis.patch.yml  DSH 插件注册补丁
└── package.json      插件元数据
```

### 引擎设计（对照 MiniMax H3 官方规范 + NiliX 2026-08-24 实战）
- **H3 工作流**：FL2VA（空镜/三段式）/ Ref2VA（角色/六段式）双路径，`17k+5` 帧网格，Turbo LoRA 提速，MotionContext 接缝 latent 链
- **方案生成**：DeepSeek 直出 角色（role 阵营/五视图/拟漫化 image_prompt）/场景/分镜（directing 防同质化五维 + 判停清单）+ 逐镜完整 H3 提示词（素材注入：人物/场景提示词、设定集、封面）
- **资产生成**：定妆固定 1024×1024（与画幅解耦）+ charSeed 稳定种子；五视图 front/full/side/detail/q（Z-Image img2img 保身份换视角；Q版仅正角）；场景强制空景无人+方形
- **逐镜提示词**：Ref2VA 六段式多视图 Subject、拟漫化锚句、输出体积硬约束（1500 tokens）、28 条写作规则（ai-film-skills 整合）
- **合成质检**：FFmpeg concat + loudnorm + faststart；ffprobe 机械质检（时长/音视频流/亮度暗像素 >50% 判黑屏）
- **状态管理**：run_state.json + run.log 本地落盘，断点续跑幂等；条件缓存带项目前缀防串用

### H3 合规（内建校验）
- 短边 ≤768 且 32 倍数网格（draft 416 / standard 768 / fhd 1088）
- 风格 8 预设：`2.5d / real / 3d / anime / handdrawn / papercraft / clay / ink`（可 `+` 组合或英文自定义）
- 定妆照即 Ref2VA `<Picture N>` 身份源，跨镜外观逐字一致
- 台词 `<d>[中文]原文</d>` 逐字；旁白走画外音（H3 原生），不 TTS

---

## 📦 安装

```bash
# 前提：DSH（DeepSeek Harness）已安装，web 端可用
# 本机安装（file: 链接指向本仓库）
dsh plugin --profile web add file:C:/path/to/manju-flow-plugin

# 或从 GitHub 安装（发布后）
dsh plugin --profile web add manju-flow@github:YiIimini/manju-flow
```

安装后重启 DSH web（或按页面提示刷新），侧栏输入框右侧出现 🎬 按钮。

### 依赖
| 组件 | 用途 | 端口 |
|---|---|---|
| ComfyUI | H3 视频/图片渲染（FL2VA/Ref2VA/Z-Image/SDXL） | 8190 |
| DeepSeek API Key | 方案/提示词/剧本生成 | - |
| FFmpeg / ffprobe | 合成/质检 | - |
| RTX 显卡（推荐 24GB+） | H3 渲染 | - |

---

## 🚀 快速开始

```bash
# 1. 体检环境（ComfyUI 是否就绪）
manju_render_health

# 2. 写小说（shuangwen-novel 管线）
manju_novel_scaffold project=我的新书 genre=玄幻 style=爽文 chapters=56
# → 写设定集/设定集与大纲.md → 逐卷派写章子代理 → QA → 封面 → 素材 → 全本

# 3. 渲染成片（1 章 = 1 集）
manju_render_config project=我的新书 style=real
manju_render_run project=我的新书 phase=plan episode=1    # EP01=第1章
manju_render_run project=我的新书 phase=assets episode=1   # 定妆照/场景图
manju_render_run project=我的新书 phase=render episode=1   # 逐镜 H3（每镜约 3-9 分钟）
manju_render_run project=我的新书 phase=qc episode=1       # 质检
manju_render_run project=我的新书 phase=assemble episode=1 # 合成成片

# 或一键全流程
manju_render_run project=我的新书 phase=all episode=1

# 4. 轮询状态
manju_render_status project=我的新书
```

---

## 🔌 开发

```bash
# 本地安装开发（file: 链接，改动即生效）
npm install -D  # 可选

# 语法检查
node --check index.js && node --check engine.js && node --check client.js

# 测试（Node 冒烟测试，mock shell 服务）
node test/engine-smoke.js
```

### 目录约定
- 小说库根目录：`C:/Mi/Ai/WorkBench/novel`（可配置）
- 漫剧项目根目录：`C:/Mi/Ai/WorkBench/NiliX/manju`（可配置）
- 项目结构：`<project>/{analysis, assets/characters, assets/scenes, clips/<EP>}/`
- 状态：`<project>/run_state.json` + `run.log`
- 成片：`<project>/<EP>_成片.mp4`

---

## 📄 协议

[MIT](./LICENSE) © YiIimini

---

## 🙏 致谢
- [MiniMax H3](https://github.com/MiniMax-AI/H3-Audio-Video)（视频生成模型）
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)（渲染后端）
- [DeepSeek](https://platform.deepseek.com/)（LLM）
- [shuangwen-novel](https://github.com/)（爽文小说创作管线）
