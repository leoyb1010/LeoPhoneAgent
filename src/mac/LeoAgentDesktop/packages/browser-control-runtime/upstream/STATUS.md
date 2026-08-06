# Browser Control Runtime — Status

> 维护细节(架构、踩坑、上游同步)在 **`MAINTAINING.md`**,本文件只记交付现状。
> 早期(2026-06-19)半成品评估快照见 git 历史,已被本现状取代——别再当作"还没建完"。

## 现状:已交付并接入

浏览器自动化已端到端跑通并接入桌面端:

- **L1 vendored runtime**(`@cindy/browser-control-runtime`):`sync.mjs` 可复现地拉取上游核心 + 未发布包 + fs-safe dist 并机械重写 import;全部 shim 写齐,`build`(tsc --noEmit)+ `test`(runtime / SSRF guard / sanitize / 配置应用回归)通过。
- **L2 MCP 面**(`@cindy/mcps/src/browser`):单 `browser` 工具(17 action)+ `browser-workflow.md` 用法 rules,经 `list_tools` 下发;注册为 `cindy_browser` provider。
- **L3 desktop host**:托管单例 runtime(默认 headed 持久 "Cindy" profile)、`BROWSER_STATUS` / `BROWSER_OPEN_FOR_LOGIN` IPC、设置 →「自动操作」面板 + 4 语言 i18n、builtin-plugin 开关(默认开,项目级 override)。
- **agent 暴露**:Claude Code + 本地 Codex 均可用(同一进程内 server / 同一持久 profile);远端 Codex 不支持 lizi MCP 桥接(已知限制)。

## 安全

SSRF / 路径包含的决策逻辑保持 vendored,只重写 fetch 外壳;`ssrf-guard.test.ts` 守护拦截 cloud-metadata / 私网 IP 的能力,弱化即挂 CI。

## 已知限制(非 bug)

- Chrome profile 头像不能用自定义本地图(只认内置 / Google 账号头像)。
- profile `color` 是 Material-You 种子色,纯灰度做不到,故用高饱和 TapTap teal。
- 远端 Codex 会话无 `lizi_*` 工具(含浏览器)。
