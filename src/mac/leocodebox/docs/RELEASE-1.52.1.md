# leocodebox 1.52.1 — 驾驶舱数据接线修复

1.52.0 的首页驾驶舱在真机上多张卡片读不到数据(Agent 全红「未登录」、Mission 空、今日用量与实际不符)。本版修复驾驶舱与后端的接线错误,以及一个 GUI 启动上下文下的登录态误判。纯修复,无新功能。

## 修了什么

**驾驶舱端点路径错(前端)**——数据 hook 调了不存在的路径,落到 SPA HTML 上,导致卡片空白:
- CLI 状态:`/api/leocodebox/cli-tools/status` → 正确的 `/api/leocodebox/cli/status`(Agent 网格恢复安装态/版本/可更新)
- Mission:`/api/missions` → 正确的 `/api/leocodebox/missions`(看板摘要恢复计数与在跑卡)
- 一键安装:`/api/leocodebox/cli-tools/:id/install` → `/api/leocodebox/cli/:id/install`
- Mission 卡片字段对齐真实返回(`id`/`costUsd`,原用了不存在的 `card_id`/`cost_usd`)

**登录态在 GUI 启动下被误判为「未登录」(后端)**——App 通过 `open` 启动(无控制终端)时,探测 CLI 版本的 `spawn` 会持续 `EBADF`;5 个 provider 的鉴权此前一遇该错就直接返回「could not run」,**从不读凭证文件**,于是明明已登录也显示未登录/红点。改为:版本探测失败不再短路,继续走基于文件的凭证检测(claude/codex/opencode/grok 的凭证在本地文件里,无需 spawn)。CLI 可运行性改由 cli/status 单独判定。此外,claude 的 `claude auth status` 在 GUI 上下文会返回 `authMethod:none`(spawn 环境与用户 shell 不同),此前该负向结果会覆盖磁盘上有效的 OAuth 令牌;改为仅当 CLI 明确已认证才采信 CLI,否则以磁盘 `claude /login` 令牌为准。实测修复后 claude/codex/opencode/grok 均正确显示已登录。

## 说明(诚实标注)
- 用量中心「今日」为 0 是**真实数据**:`usage_daily` 只统计经 leocodebox 发起的会话;直接用 Claude Code CLI 的用量只进 jsonl,由「Claude 窗口消耗」卡展示(5h/7d 真实 IO tokens)。两块口径不同,不是没读到。

## 验证
- typecheck 0、lint 0、client 71/71、server 299/299(provider auth 两条测试改为断言「不再短路、继续解析鉴权」的新契约)
- 修复后用本机 token 实测 6 个驾驶舱端点均返回正确数据(见发布记录)

## 下载校验
- DMG SHA-256:`4edc7b1b76b9b94358495508a12499d0299e7a5c81db647221cc7a762d33bf13`
- ZIP SHA-256:`2f90594b92bfe3f3cd92e03117a9091abe13d360d1525729dbedec00b9973ad4`
- `latest-mac.yml` SHA-256:`0796c24ce862ac72e299f91a36426b58a6b7646be6462fda8113b217f61124b0`
