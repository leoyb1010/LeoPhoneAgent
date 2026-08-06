/**
 * BROWSER_PARTITION — RSB 内置浏览器(web-browser plugin)使用的 Electron session
 * partition,单一来源。
 *
 * 命名规则:`persist:` 前缀让 Electron 把 cookie / IndexedDB / cache / localStorage
 * 持久化到 userData 下的子目录(关 app 重开仍登录态保留)。
 * `xdmaker-browser-app` 是分区名,跟 Feishu OAuth 用的默认 session(空 partition)、
 * Electron 主窗 webContents 自己的 session 等所有内部 session 都隔离开,网页不会
 * 看到应用本身的 cookie / IDB。
 *
 * Phase 4 主进程 webview hardener 用它强制覆盖所有 `<webview>` 的 partition 属性,
 * 即便 renderer 端写了别的 partition 或没写,最终落到 guest webContents 上的都是
 * 这一个 partition;Phase 5 web-browser plugin 渲染 `<webview partition={...} />`
 * 也用它(双保险:即使硬编码忘了带,hardener 兜底)。
 *
 * 同时跨 main / renderer 共用,放到 shared/ 保持单一来源。
 */
export const BROWSER_PARTITION = 'persist:xdmaker-browser-app';
