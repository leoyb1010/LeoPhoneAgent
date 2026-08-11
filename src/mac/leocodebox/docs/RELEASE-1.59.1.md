# leocodebox 1.59.1 — 修:终端已登录,应用内却显示「未登录」

**症状**:在终端 `claude /login` 授权成功(`claude auth status` 明确返回 `loggedIn: true`),但 leocodebox 的「Agent 授权与安装」里 Claude Code 一直显示**未登录**,重登多次无效。

## 根因
新版 Claude Code 登录后,**有效凭据不再写回 `~/.claude/.credentials.json`**(实际凭据落在 macOS Keychain),那个文件成了**不再更新的陈旧残留**——里面的 `accessToken` 早就过期、`expiresAt` 停在上次写入的时间。

而 leocodebox 的判定链是:环境变量 → `settings.json` → `claude auth status` → `.credentials.json`。在打包 GUI 进程里 `claude` 的 spawn 会失败(`spawn EBADF`,`--version` 也读不出、`version: null`),拿不到 CLI 的 `loggedIn: true` 权威值,于是**回落到那份陈旧文件**,看见 `expiresAt` 已过 → 判「登录已过期 / 未登录」。

于是形成死结:**真实已登录,但应用一直报未登录,且重新登录也不会改变那个文件**。

## 修复
**过期的 access token 不等于登出**:只要凭据里存在 `refreshToken`,就判定为**已登录**——CLI 会在下次调用时用它静默续期,且真实会话本就不依赖这份文件。

- 有 `refreshToken` + access token 过期 → **已登录**(本次修复)
- access token 未过期 → 已登录(不变)
- 过期且**没有** `refreshToken` → 仍如实报「登录已过期,请重新 `claude /login`」(不变)

同时明确:`spawn EBADF` 只代表探测失败,**不得**用来否定登录状态(`installed` 保持 true、`version` 为 null 也不再连累登录判定)。

## 验证
- 门禁全绿:typecheck 0、ESLint 0、client 71/71、server **326/326**、生产构建通过。
- 新增 3 条单测(隔离临时配置目录,注入「所有 spawn 都 EBADF」精确复现本故障):
  - 过期 access token + 有 refreshToken → **已登录**,且 `installed:true` / `version:null` 不影响判定;
  - 未过期 → 已登录(回归保护);
  - 过期 + 无 refreshToken → 仍报已过期(不误报已登录)。
- 装机后以**真实过期凭据**实测端点返回 `authenticated: true`。

## 下载校验
- DMG SHA-256:`fb7e13cc32efecb9963c5c7625a8f38c845635c83354a1b090a233b7c393af4e`
- ZIP SHA-256:`31304b849eb88116ea846a444d246119edd9e1865d8f5ca6847fc7f87dcdd045`
- `latest-mac.yml` SHA-256:`061580622f9c3e88214abbeb2fba7912efc3a62cdaab0c91291f60740ddf821c`

> 注:本版 DMG 未做窗口背景美化(本机 Finder 自动化权限被系统重置,-1743),纯功能包,不影响安装/签名/公证/热更新。
