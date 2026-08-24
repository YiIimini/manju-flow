// 漫剧控制台 — Client 半边（正式插件包，重启持久）
// 侧栏「漫剧」按钮 + 多标签完整管理台（总览/小说/项目/渲染/风格/设置）。
// 所有数据经 ctx.remote.manjuConsole.* 走 Host 业务（自研引擎，零 NiliX 依赖）。
// descriptors 与 host INVOCATIONS 逐字一致。
window.__ModuleLoader__.load({
	id: "manju-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var ReactDOM = require("react-dom");

		// ── Remote 装配描述（与 index.js M4 INVOCATIONS 一致）──────────────────
		// ★ 2026-08-24 修复：codec 必须 mode:"strict" + typeSymbol + schema.parse——
		//   旧格式 { mode:'src-json' } 被 api-gateway requireStrictCodec 拒绝 → $mount 失败。
		//   ★ client 模块表无 zod（require 会抛 "missed the module table"）→ 用最小
		//     passthrough parser 替代（api-gateway 只调用 codec.schema.parse(value)，
		//     语义 = JSON 透传，与 src-json 等价但满足 strict 校验）。
		var passthrough = (typeSymbol) => ({
			parse(value) { return value; },
			_schemaType: typeSymbol,
		});
		var ARGS_SCHEMA = passthrough("manju-flow#manjuConsole/args");
		var ANY_SCHEMA = passthrough("any");
		const PARAM_ARGS = [{
			name: "args", wire: "args", source: "json",
			codec: { mode: "strict", typeSymbol: "manju-flow#manjuConsole/args", schema: ARGS_SCHEMA },
		}];
		const DESCRIPTORS = [
			"platform", "projects", "status", "health", "config", "run", "kill", "post",
			"comfy", "create", "gacha", "qc", "agent", "notify", "manage", "plan"
		].map((m) => ({
			id: "manju-flow#manjuConsole/" + m,
			service: "manjuConsole",
			namespace: "manjuConsole",
			method: m,
			invocation: { kind: "direct" },
			parameters: (m === "platform" || m === "projects") ? [] : PARAM_ARGS,
			result: { mode: "strict", typeSymbol: "manju-flow#manjuConsole/" + m + ":result", schema: ANY_SCHEMA },
		}));

		// ★ 2026-08-24 修复：不能 inject "remote.manjuConsole"——namespace 服务在
		//   $mount 异步挂载后才提供，inject 声明会导致插件激活永久等待
		//   （"pending: waiting for service: remote.manjuConsole"）。
		//   $mount 后用 ctx.get('remote.manjuConsole') 惰性取（Cordis 点路径服务解析）。
		const inject = ["slots", "remote"];

		// ── 样式常量 ──────────────────────────────────────────────────────────
		const btn = { padding: "4px 10px", fontSize: 12, border: "1px solid #8884", borderRadius: 4, background: "#ffffff0d", cursor: "pointer", color: "#e6e6e6" };
		const btnDanger = Object.assign({}, btn, { color: "#f85149" });
		const btnPrimary = Object.assign({}, btn, { background: "#23863633", borderColor: "#23863688", color: "#7ee787" });
		const input = { padding: "4px 6px", background: "#ffffff0d", border: "1px solid #8884", borderRadius: 4, color: "#e6e6e6", fontSize: 12 };
		const label = { fontSize: 11, color: "#999", whiteSpace: "nowrap" };
		const row = { display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" };
		const tabStyle = (active) => ({ padding: "5px 10px", fontSize: 12, border: "none", background: active ? "#23863633" : "transparent", color: active ? "#7ee787" : "#999", cursor: "pointer", borderRadius: 4, fontWeight: active ? 600 : 400 });
		const panelStyle = { position: "fixed", top: 16, right: 16, width: 560, maxHeight: "86vh", overflow: "auto", background: "#1a1d23", border: "1px solid #ffffff22", borderRadius: 10, padding: 12, zIndex: 9999, boxShadow: "0 8px 32px #0008", pointerEvents: "auto", fontFamily: "system-ui, sans-serif", color: "#e6e6e6" };
		const logStyle = { marginTop: 8, maxHeight: 160, overflow: "auto", fontSize: 11, color: "#999", background: "#0008", borderRadius: 6, padding: 6 };
		const cardStyle = { background: "#ffffff0a", border: "1px solid #ffffff14", borderRadius: 6, padding: 8, marginBottom: 8 };

		// ── 小工具 ────────────────────────────────────────────────────────────
		// ★ 修复 2026-08-24：h 必须透传全部 children——旧签名 (type, props, children)
		//   只取第一个子元素，多个 children（如头部4个子节点）被静默丢弃 → 面板空白。
		const h = (type, props, ...children) => React.createElement(type, props, ...children);
		const Btn = (p, label, extra) => h("button", Object.assign({ style: btn, disabled: p.busy }, extra || {}), label);
		const Input = (value, onChange, placeholder, style) => h("input", { value, onChange: (e) => onChange(e.target.value), placeholder, style: Object.assign({}, input, style || {}) });
		const Card = (title, children) => h("div", { style: cardStyle },
			title && h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#ccc" } }, title),
			children);

		// ── 主面板：6 标签管理台 ─────────────────────────────────────────────
		function ConsolePanel({ api, ctx, onClose }) {
			const [state, setState] = React.useState({ platform: null, projects: [], project: "", status: null, busy: false, msg: "", tab: "总览", comfyInfo: null, env: null, plan: null });
			const [create, setCreate] = React.useState({ open: false, name: "", novel: "", apiKey: "" });
			const [configForm, setConfigForm] = React.useState({ style: "real", width: 768, height: 1344, fps: 24, steps: 20, turboSteps: 8, seed: 1688, fl2vaEndFrame: false });
			const [gacha, setGacha] = React.useState({ char: "", view: "" });
			const [qc, setQc] = React.useState({ shot: "", skip: "" });
			const [chat, setChat] = React.useState({ text: "" });
			const [novelInfo, setNovelInfo] = React.useState(null);
			const set = (p) => setState((s) => Object.assign({}, s, p));

			const refreshAll = () => {
				api.platform().then((r) => set({ platform: r && r.ok === false ? { up: false } : r })).catch(() => set({ platform: { up: false } }));
				api.projects().then((r) => set({ projects: (r && r.projects) || [] })).catch(() => set({ projects: [] }));
				api.comfy({ action: "status" }).then((r) => set({ comfyInfo: r })).catch(() => set({ comfyInfo: null }));
			};
			React.useEffect(() => { refreshAll() }, []);
			React.useEffect(() => {
				if (!state.project) return undefined;
				const id = setInterval(() => {
					api.status({ project: state.project }).then((r) => set({ status: r })).catch(() => set({ status: null }));
				}, 3000);
				return () => { clearInterval(id) };
			}, [state.project]);

			const act = (method, args, doneMsg) => {
				if (state.busy) return;
				set({ busy: true, msg: "执行中…" });
				api[method](Object.assign({ project: state.project }, args || {}))
					.then((r) => {
						const body = (r && r.ok === false) ? ("失败: " + (r.error || "")) : (doneMsg || (r && r.error ? r.error : JSON.stringify(r).slice(0, 260)));
						set({ busy: false, msg: body });
						if (["run", "kill", "post", "gacha", "qc", "comfy"].indexOf(method) >= 0) {
							setTimeout(() => { api.status({ project: state.project }).then((r) => set({ status: r })).catch(() => set({ status: null })) }, 800);
						}
						if (method === "manage" && args && args.action === "projects") refreshAll();
					})
					.catch((e) => set({ busy: false, msg: "失败: " + String((e && e.message) || e) }));
			};
			const runStage = (phase, agent) => act("run", { phase, episode: 0, agent: !!agent }, "已启动 " + phase + (agent ? "（AI）" : "") + " → 状态标签看进度");
			const copyLog = () => {
				const tail = (state.status && state.status.logTail) || [];
				const text = tail.join("\n");
				if (!text) { set({ msg: "无日志可复制" }); return }
				try { navigator.clipboard.writeText(text).then(() => set({ msg: "日志已复制" })).catch(() => set({ msg: "复制失败" })) } catch (e) { set({ msg: "复制失败: " + String(e) }) }
			};

			const st = state.status && state.status.status;
			const running = !!(st && st.running);
			const stage = (st && st.currentStage) || (st && st.stage) || "";
			const progress = (st && st.progress) || 0;
			const logTail = (state.status && state.status.logTail) || [];
			const platform = state.platform || {};
			const comfyOnline = !!(state.comfyInfo && state.comfyInfo.online);

			// 标签页渲染
			const renderTab = () => {
				switch (state.tab) {
					// ── 监控（实时状态）──
					case "监控": {
						const st2 = state.status && state.status.status;
						const running2 = !!(st2 && st2.running);
						const stage2 = (st2 && st2.currentStage) || "";
						const done2 = st2 ? Number(st2.shotCur) || 0 : 0;
						const total2 = st2 ? Number(st2.shotTotal) || (state.status && state.status.clips ? state.status.clips.length : 0) : 0;
						const pct2 = total2 > 0 ? Math.min(100, Math.round((done2 / total2) * 100)) : 0;
						const barStyle = { height: 8, background: "#ffffff14", borderRadius: 4, overflow: "hidden", marginTop: 4 };
						const fillStyle = { height: "100%", background: running2 ? "#238636" : "#8b949e", width: pct2 + "%", transition: "width .5s" };
						const clips2 = (state.status && state.status.clips) || [];
						const final2 = state.status && state.status.finalOutput;
						return h("div", null,
							Card("🖥 渲染实时监控（每 3s 刷新）", h("div", null,
								h("div", { style: row },
									h("span", { style: Object.assign({}, label, { fontSize: 13 }) }, "状态："),
									h("span", { style: { fontSize: 13, fontWeight: 600, color: running2 ? "#7ee787" : (stage2 === "done" ? "#58a6ff" : "#999") } }, running2 ? "🔄 渲染中" : (stage2 === "done" ? "✅ 已完成" : "⏸ 空闲")),
									h("span", { style: Object.assign({}, label, { marginLeft: 10 }) }, "阶段：" + (stage2 || "-")),
									h("span", { style: Object.assign({}, label, { marginLeft: 10 }) }, "ComfyUI：" + (comfyOnline ? "● 在线" : "○ 离线")),
								),
								h("div", { style: row },
									h("span", { style: label }, "镜头进度：" + done2 + " / " + total2),
									h("span", { style: Object.assign({}, label, { marginLeft: 10 }) }, pct2 + "%"),
								),
								h("div", { style: barStyle }, h("div", { style: fillStyle })),
								h("div", { style: Object.assign({}, row, { marginTop: 6 }) },
									h("span", { style: label }, "项目：" + state.project),
									final2 && h("a", { href: "file:///" + final2.replace(/\\/g, "/"), style: { fontSize: 11, color: "#58a6ff", marginLeft: 8 } }, "📹 成片"),
								),
							)),
							Card("🎬 镜头产物", h("div", null,
								clips2.length === 0 ? h("div", { style: { fontSize: 12, color: "#666" } }, "（暂无镜头产物）") :
								h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
									clips2.map((c) => h("span", { key: c, style: { fontSize: 11, padding: "2px 6px", background: "#23863622", borderRadius: 4, color: "#7ee787" } }, c))),
							)),
							Card("📄 运行日志（滚动）", h("div", null,
								h("div", { style: Object.assign({}, logStyle, { maxHeight: 220 }) },
									logTail.slice(-18).map((l, i) => h("div", { key: i, style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }, l)),
									!logTail.length && h("div", { style: { color: "#666" } }, "（无日志）"),
								),
							)),
						);
					}
					// ── 总览 ──
					case "总览": return h("div", null,
						Card("平台状态", h("div", null,
							h("div", { style: row },
								h("span", { style: Object.assign({}, label, { fontSize: 12 }) }, "🖥 引擎："),
								h("span", { style: { fontSize: 12, color: "#7ee787" } }, "自研（零 NiliX）"),
								h("span", { style: Object.assign({}, label, { marginLeft: 12, fontSize: 12 }) }, "ComfyUI："),
								h("span", { style: { fontSize: 12, color: comfyOnline ? "#7ee787" : "#f85149" } }, comfyOnline ? "● 在线" : "○ 离线"),
								state.comfyInfo && state.comfyInfo.info && h("span", { style: Object.assign({}, label, { marginLeft: 8 }) }, "v" + (state.comfyInfo.info.comfyui_version || "")),
							),
							h("div", { style: Object.assign({}, row, { marginTop: 6 }) },
								h("span", { style: label }, "当前项目："),
								h("select", { value: state.project, onChange: (e) => { set({ project: e.target.value, status: null }) }, style: Object.assign({}, input, { flex: 1 }) },
									h("option", { value: "" }, "选择漫剧项目…"),
									state.projects.map((p) => h("option", { key: p, value: p }, p))),
								Btn(state, "刷新", { onClick: refreshAll }),
								Btn(state, "＋ 新建", { onClick: () => setCreate(Object.assign({}, create, { open: !create.open })) }),
							),
							create.open && h("div", { style: Object.assign({}, row, { background: "#ffffff0d", borderRadius: 6, padding: 6 }) },
								Input(create.name, (v) => setCreate(Object.assign({}, create, { name: v })), "剧名（必填）", { width: 90 }),
								Input(create.novel, (v) => setCreate(Object.assign({}, create, { novel: v })), "小说路径（必填）", { flex: 1, minWidth: 180 }),
								Input(create.apiKey, (v) => setCreate(Object.assign({}, create, { apiKey: v })), "DeepSeek Key（可空）", { width: 110 }),
								Btn(state, "创建", {
									disabled: state.busy || !create.name || !create.novel,
									onClick: () => {
										act("create", { name: create.name, novel: create.novel, apiKey: create.apiKey || undefined }, "项目创建完成（本地 config）");
										setCreate({ open: false, name: "", novel: "", apiKey: "" });
										setTimeout(refreshAll, 600);
									}
								}),
							),
						)),
						Card("漫剧管线（一条龙）", h("div", null,
							h("div", { style: row },
								Btn(state, "方案 plan", { onClick: () => runStage("plan") }),
								Btn(state, "资产 assets", { onClick: () => runStage("assets") }),
								Btn(state, "编码 encode", { onClick: () => runStage("encode") }),
								Btn(state, "渲染 render", { onClick: () => runStage("render") }),
								Btn(state, "质检 qc", { onClick: () => runStage("qc") }),
								Btn(state, "合成 assemble", { onClick: () => runStage("assemble") }),
							),
							h("div", { style: row },
								Btn(state, "⚡ 一条龙 all", { onClick: () => runStage("all") }),
								Btn(state, "🤖 AI 一条龙", { onClick: () => runStage("all", true) }),
								h("button", { style: btnDanger, disabled: state.busy || !state.project, onClick: () => act("kill", {}, "已请求停止") }, "⏹ 停止"),
								Btn(state, "🩺 体检", { onClick: () => act("health", { fix: true }, "体检修复完成") }),
								Btn(state, "⚙️ 生成config", { onClick: () => act("config", {}, "config 已生成/更新") }),
							),
							h("div", { style: row },
								h("span", { style: label }, "状态：" + (running ? "🔄 " + stage + " " + Math.round(progress) + "%" : (stage === "done" ? "✅ 完成" : (stage ? "阶段 " + stage : "空闲")))),
								state.status && state.status.finalOutput && h("a", { href: "file:///" + state.status.finalOutput.replace(/\\/g, "/"), style: { fontSize: 11, color: "#58a6ff" } }, "📹 成片 " + state.status.finalOutput.split("/").pop()),
							),
							h("div", { style: row },
								h("span", { style: label }, "后处理："),
								Btn(state, "✂️ 预告片", { onClick: () => act("post", { action: "trailer" }, "预告片已生成（本地 FFmpeg）") }),
								Btn(state, "🧹 清理", { onClick: () => act("post", { action: "cleanup" }, "已清理") }),
								Btn(state, "📊 目录占用", { onClick: () => act("post", { action: "cleanup-sizes" }, "") }),
							),
						)),
						h("div", { style: row, justifyContent: "space-between" },
							h("span", { style: label }, "run.log（5s 刷新）"),
							h("div", { style: { display: "flex", gap: 6 } },
								Btn(state, "📋 复制", { onClick: copyLog }),
								Btn(state, "清空", { onClick: () => set({ status: Object.assign({}, state.status, { logTail: [] }) }) }),
							),
						),
						h("div", { style: logStyle },
							logTail.slice(-14).map((l, i) => h("div", { key: i, style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }, l)),
							!logTail.length && h("div", { style: { color: "#666" } }, "（无日志；选择项目后自动轮询）"),
						),
					);

					// ── 小说 ──
					case "小说": return h("div", null,
						Card("小说库（novel 根目录）", h("div", null,
							h("div", { style: row },
								Btn(state, "📖 查看小说信息", { disabled: !state.project, onClick: () => act("manage", { action: "novel-info" }, "") }),
								Btn(state, "📚 项目列表", { onClick: () => act("manage", { action: "projects" }, "") }),
								Btn(state, "🔍 按小说查项目", { onClick: () => act("manage", { action: "find", novel: create.novel || undefined }, "") }),
							),
							h("div", { style: row },
								Input(create.novel, (v) => setCreate(Object.assign({}, create, { novel: v })), "小说路径（查找用）", { flex: 1 }),
							),
						)),
						Card("小说创作（shuangwen-novel）", h("div", null,
							h("div", { style: Object.assign({}, row, { fontSize: 12, color: "#999" }) },
								"小说管线在对话中执行：先 manju_novel_scaffold 立项 → 写设定集 → dispatch 派卷 → 并行写章 → QA → 封面 → 素材导出 → 全本。",
							),
							h("div", { style: row },
								Btn(state, "📄 保存正文到库", { onClick: () => act("manage", { action: "novel-save", text: "（请在对话中传正文）", title: create.name || undefined }, "") }),
							),
						)),
						novelInfo && Card("小说信息", h("pre", { style: { fontSize: 11, margin: 0, whiteSpace: "pre-wrap" } }, JSON.stringify(novelInfo, null, 2))),
					);

					// ── 项目 ──
					case "项目": return h("div", null,
						Card("项目配置（config.json）", h("div", null,
							h("div", { style: row },
								Btn(state, "📄 查看项目配置", { disabled: !state.project, onClick: () => act("manage", { action: "project" }, "") }),
								Btn(state, "⚙️ 保存渲染配置", { disabled: !state.project, onClick: () => act("manage", {
									action: "render-save",
									style: configForm.style, width: Number(configForm.width), height: Number(configForm.height),
									fps: Number(configForm.fps), steps: Number(configForm.steps), turboSteps: Number(configForm.turboSteps), seed: Number(configForm.seed),
									fl2vaEndFrame: !!configForm.fl2vaEndFrame,
								}, "渲染配置已保存（服务端校验）") }),
								Btn(state, "🗑 删除项目", { disabled: !state.project, onClick: () => { if (confirm("确认删除项目 " + state.project + "？")) act("manage", { action: "delete" }, "项目已删除") } }),
							),
							h("div", { style: row },
								h("span", { style: label }, "风格："),
								Input(configForm.style, (v) => setConfigForm(Object.assign({}, configForm, { style: v })), "real", { width: 130 }),
								h("span", { style: label }, "宽/高："),
								Input(String(configForm.width), (v) => setConfigForm(Object.assign({}, configForm, { width: v })), "768", { width: 54 }),
								h("span", { style: { fontSize: 11, color: "#666" } }, "×"),
								Input(String(configForm.height), (v) => setConfigForm(Object.assign({}, configForm, { height: v })), "1344", { width: 54 }),
								h("span", { style: label }, "fps："),
								Input(String(configForm.fps), (v) => setConfigForm(Object.assign({}, configForm, { fps: v })), "24", { width: 40 }),
							),
							h("div", { style: row },
								h("span", { style: label }, "步数："),
								Input(String(configForm.steps), (v) => setConfigForm(Object.assign({}, configForm, { steps: v })), "20", { width: 44 }),
								h("span", { style: label }, "turbo："),
								Input(String(configForm.turboSteps), (v) => setConfigForm(Object.assign({}, configForm, { turboSteps: v })), "8", { width: 44 }),
								h("span", { style: label }, "seed："),
								Input(String(configForm.seed), (v) => setConfigForm(Object.assign({}, configForm, { seed: v })), "1688", { width: 70 }),
							),
							h("div", { style: row },
								h("label", { style: Object.assign({}, label, { display: "flex", alignItems: "center", gap: 4 }) },
									h("input", { type: "checkbox", checked: !!configForm.fl2vaEndFrame, onChange: (e) => setConfigForm(Object.assign({}, configForm, { fl2vaEndFrame: e.target.checked })) }),
									"FL2VA 尾帧锚定（空镜防段尾漂移，成本翻倍）"),
							),
						)),
						Card("ComfyUI 管理", h("div", { style: row },
							Btn(state, "🔌 状态", { onClick: () => act("comfy", { action: "status" }, "") }),
							Btn(state, "▶ 启动", { onClick: () => act("comfy", { action: "start" }, "已请求启动（最长等 90s）") }),
							Btn(state, "⏹ 停止", { onClick: () => act("comfy", { action: "stop" }, "已请求关闭") }),
							h("span", { style: Object.assign({}, label, { fontSize: 12 }) }, comfyOnline ? "● 在线" : "○ 离线"),
						)),
						Card("环境自检", h("div", { style: row },
							Btn(state, "🔍 env", { onClick: () => act("manage", { action: "env" }, "") }),
							Btn(state, "📁 paths", { onClick: () => act("manage", { action: "paths" }, "") }),
							Btn(state, "📦 models", { onClick: () => act("manage", { action: "models" }, "") }),
						)),
					);

					// ── 渲染 ──
					case "渲染": return h("div", null,
						Card("阶段执行", h("div", null,
							h("div", { style: row },
								Btn(state, "方案 plan", { onClick: () => runStage("plan") }),
								Btn(state, "资产 assets", { onClick: () => runStage("assets") }),
								Btn(state, "编码 encode", { onClick: () => runStage("encode") }),
								Btn(state, "渲染 render", { onClick: () => runStage("render") }),
								Btn(state, "质检 qc", { onClick: () => runStage("qc") }),
								Btn(state, "合成 assemble", { onClick: () => runStage("assemble") }),
							),
							h("div", { style: row },
								Btn(state, "⚡ 一条龙 all", { onClick: () => runStage("all") }),
								Btn(state, "🤖 AI 一条龙", { onClick: () => runStage("all", true) }),
								h("button", { style: btnDanger, disabled: state.busy || !state.project, onClick: () => act("kill", {}, "已请求停止") }, "⏹ 停止"),
							),
							h("div", { style: row },
								h("span", { style: label }, "状态：" + (running ? "🔄 " + stage + " " + Math.round(progress) + "%" : (stage === "done" ? "✅ 完成" : (stage ? "阶段 " + stage : "空闲")))),
								state.status && state.status.clips && h("span", { style: Object.assign({}, label, { fontSize: 12, color: "#7ee787" }) }, "镜头：" + state.status.clips.length + " 个"),
							),
						)),
						Card("角色抽卡", h("div", null,
							h("div", { style: row },
								h("span", { style: label }, "角色："),
								Input(gacha.char, (v) => setGacha({ char: v, view: gacha.view }), "角色名", { width: 90 }),
								h("span", { style: label }, "视图："),
								h("select", { value: gacha.view, onChange: (e) => setGacha({ char: gacha.char, view: e.target.value }), style: Object.assign({}, input, { width: 76 }) },
									["", "front", "full", "side", "detail", "q"].map((v) => h("option", { key: v, value: v }, v || "主图"))),
								Btn(state, "🎴 抽卡", { disabled: !gacha.char, onClick: () => act("gacha", { action: "draw", char: gacha.char, view: gacha.view || undefined }, "已请求抽卡") }),
								Btn(state, "角色方案", { onClick: () => act("gacha", { action: "plan" }, "已请求角色方案") }),
								Btn(state, "📤 上传采纳", { disabled: !gacha.char, onClick: () => act("gacha", { action: "upload", char: gacha.char, view: gacha.view || undefined, image: prompt("本地图片绝对路径：") || "" }, "") }),
							),
							h("div", { style: Object.assign({}, row, { fontSize: 11, color: "#888" }) },
								"视图：front=正脸特写 / full=全身 / side=侧面 / detail=细节 / q=Q版（仅正角）。视图基于主图 img2img 保身份（2026-08-24）。",
							),
						)),
						Card("质检", h("div", null,
							h("div", { style: row },
								h("span", { style: label }, "跳过镜头："),
								Input(qc.skip, (v) => setQc(Object.assign({}, qc, { skip: v })), "如 3,7", { width: 70 }),
								Btn(state, "跳过", { disabled: !qc.skip, onClick: () => act("qc", { action: "decision", skip: qc.skip }, "已设置跳过镜头") }),
								h("span", { style: label }, "镜头："),
								Input(qc.shot, (v) => setQc(Object.assign({}, qc, { shot: v })), "号", { width: 44 }),
								Btn(state, "🔎 重审", { disabled: !qc.shot, onClick: () => act("qc", { action: "judge", shot: Number(qc.shot) }, "") }),
								Btn(state, "↺ 返工", { disabled: !qc.shot, onClick: () => act("qc", { action: "resolve", shot: Number(qc.shot), decision: "retry" }, "已请求定点返工") }),
								Btn(state, "⏭ 忽略", { disabled: !qc.shot, onClick: () => act("qc", { action: "resolve", shot: Number(qc.shot), decision: "ignore" }, "已标记忽略") }),
							),
						)),
					);

					// ── 风格 ──
					case "风格": return h("div", null,
						Card("渲染风格", h("div", null,
							h("div", { style: row },
								h("span", { style: label }, "当前 config 风格："),
								Input(configForm.style, (v) => setConfigForm(Object.assign({}, configForm, { style: v })), "real", { width: 150 }),
								Btn(state, "💾 保存风格", { disabled: !state.project, onClick: () => act("manage", { action: "render-save", style: configForm.style }, "风格已保存") }),
							),
							h("div", { style: Object.assign({}, row, { marginTop: 6 }) }, "8 预设风格："),
							h("div", { style: row },
								["2.5d", "real", "3d", "anime", "handdrawn", "papercraft", "clay", "ink"].map((s) =>
									h("button", { key: s, style: Object.assign({}, btn, { background: configForm.style.split("+").indexOf(s) >= 0 ? "#23863655" : "#ffffff0d" }), onClick: () => setConfigForm(Object.assign({}, configForm, { style: s })) }, s)),
							),
							h("div", { style: Object.assign({}, row, { fontSize: 11, color: "#888", marginTop: 4 }) },
								"可 + 组合（如 real+ink）或英文自定义；H3 短边 ≤768 且 32 倍数。",
							),
						)),
						Card("风格分析", h("div", null,
							h("div", { style: row },
								Btn(state, "🤖 AI 推荐风格", { disabled: !state.project, onClick: () => act("agent", { action: "style" }, "") }),
								Btn(state, "🎨 风格清单", { onClick: () => act("script", { action: "styles" }, "") }),
							),
							h("div", { style: Object.assign({}, row, { fontSize: 12, color: "#999" }) },
								"风格分析由 DeepSeek 读小说样本推荐；参考「栖光」风格：real（写实电影感）+ 可叠 ink（水墨）。",
							),
						)),
					);

					// ── 设置 ──
					case "设置": return h("div", null,
						Card("智能体（审片）", h("div", null,
							h("div", { style: row },
								Btn(state, "⚙️ 审片设置", { disabled: !state.project, onClick: () => act("agent", { action: "settings" }, "") }),
								Btn(state, "📋 审片状态", { disabled: !state.project, onClick: () => act("agent", { action: "status" }, "") }),
								Btn(state, "🧪 视觉测试", { disabled: !state.project, onClick: () => act("agent", { action: "vision-test" }, "") }),
							),
							h("div", { style: row },
								h("span", { style: label }, "自然语言指令："),
								Input(chat.text, (v) => setChat({ text: v }), "如：分析当前项目并给出下一步", { flex: 1 }),
								Btn(state, "💬 发送", { disabled: !state.project || !chat.text.trim(), onClick: () => act("agent", { action: "chat", text: chat.text }, "智能体已响应") }),
							),
							h("div", { style: Object.assign({}, row, { fontSize: 11, color: "#888" }) },
								"自研引擎：判分走本地 ffprobe 机械质检；视觉模型（VLM）判分需云端，可在此配置。",
							),
						)),
						Card("通知", h("div", { style: row },
							Btn(state, "📖 配置", { onClick: () => act("notify", { action: "get" }, "") }),
							Btn(state, "🔔 测试", { onClick: () => act("notify", { action: "test" }, "测试通知已发送") }),
						)),
						Card("部署路径", h("div", { style: row },
							Btn(state, "📁 生效路径", { onClick: () => act("manage", { action: "paths" }, "") }),
							Btn(state, "📝 保存路径", { onClick: () => act("manage", { action: "paths-post" }, "") }),
							Btn(state, "🧰 技能更新", { onClick: () => act("manage", { action: "skill-update" }, "") }),
						)),
					);
					default: return null;
				}
			};

			return h("div", { style: panelStyle },
				// 头部
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
					h("span", { style: { fontWeight: 600, fontSize: 14 } }, "🎬 漫剧控制台"),
					h("span", { style: { display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: comfyOnline ? "#3fb950" : "#f85149" } }, null),
					h("span", { style: { fontSize: 11, color: "#888" } }, "自研引擎 · 零 NiliX"),
					h("button", { style: { marginLeft: "auto", border: "none", background: "none", color: "#999", cursor: "pointer", fontSize: 14 }, onClick: () => { if (typeof onClose === "function") onClose() } }, "✕"),
				),
				// 标签栏
				h("div", { style: { display: "flex", gap: 2, marginBottom: 10, borderBottom: "1px solid #ffffff14", paddingBottom: 6 } },
					["总览", "监控", "小说", "项目", "渲染", "风格", "设置"].map((t) => h("button", { key: t, style: tabStyle(state.tab === t), onClick: () => set({ tab: t }) }, t)),
				),
				// 消息行
				h("div", { style: { marginBottom: 8, fontSize: 12, color: state.msg.indexOf("失败") >= 0 ? "#f85149" : "#8bc34a", minHeight: 16 } }, state.msg),
				// 当前标签
				renderTab(),
			);
		}

		// ── 插件主体 ──────────────────────────────────────────────────────────
		async function apply(ctx) {
			// ★ 按钮/面板注册不依赖 Remote $mount：即使 Host 侧 manjuConsole 未挂载，
			//   按钮也必须出现（面板内对 Remote 调用做降级提示）。修复 2026-08-24：
			//   此前 $mount 失败直接 return → 按钮永不注册 → 用户找不到入口。
			// ★ 面板开合改用 React state（skill-picker 同款模式）：按钮组件内部
			//   useState 管理 open，面板（position:fixed 浮层）作为组件子树渲染。
			//   修复 2026-08-24：旧实现用闭包变量 open + ctx.emit("slots/change")
			//   （正确事件名是 slots/changed）→ 事件链断裂 → 点击无反应。
			const slots = ctx.get("slots");
			if (slots === undefined) {
				console.error("[manju-flow] slots 服务不可用，无法注册按钮");
				return;
			}

			let api = null;
			let mountError = "";
			try {
				const disposeMount = await ctx.remote.$mount({ package: "manju-flow", descriptors: DESCRIPTORS });
				ctx.effect(() => disposeMount);
				// namespace 服务在 $mount 后以 "remote.manjuConsole" 挂到 ctx（Cordis 点路径服务）
				// ★ 用 ctx.get 惰性取——不能 inject（inject 会等待阻塞）；不能 ctx.remote.<ns>
				//   直接访问（守卫拦截）。
				api = ctx.get("remote.manjuConsole");
			} catch (e) {
				mountError = String((e && e.message) || e);
				console.error("[manju-flow] Remote $mount failed（按钮仍注册，面板降级）:", e);
			}
			// Remote 降级代理：未挂载时所有方法返回明确错误（面板 UI 仍可浏览）
			if (!api) {
				api = new Proxy({}, {
					get: (t, m) => (typeof m === "string" ? async () => ({ ok: false, error: "Host manjuConsole 未挂载（$mount 失败" + (mountError ? ": " + mountError : "") + "）；请检查 Host 侧插件加载" }) : undefined),
				});
			}

			// ★ 按钮 + 面板：同一 React 组件，useState 控制开合（不依赖任何事件链）
			// ★ 面板用 ReactDOM.createPortal 渲染到 document.body——避免 fixed 定位
			//   被按钮 slot 容器（可能带 transform/overflow 约束）钳制导致面板塌成长条。
			//   修复 2026-08-24：此前面板作组件子树渲染，fixed 失效 → 只显示标题条。
			const ManjuButton = () => {
				const [open, setOpen] = React.useState(false);
				const panel = open ? ReactDOM.createPortal(
					React.createElement(ConsolePanel, { api, ctx, onClose: () => setOpen(false) }),
					document.body
				) : null;
				return React.createElement("div", { style: { position: "relative", display: "inline-flex", flex: "none", alignItems: "center" } },
					React.createElement("button", {
						onClick: () => setOpen(!open), title: "漫剧控制台",
						style: { border: "none", background: "none", color: "inherit", cursor: "pointer", padding: "2px 6px", fontSize: 14, display: "inline-flex", alignItems: "center" }
					}, "🎬"),
					panel,
				);
			};
			slots.inject("conversation.input.right", () => slots.register(
				{ name: "conversation.input.right", id: "manju-console", order: 50, label: "漫剧控制台" },
				ManjuButton
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
