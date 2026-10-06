/**
 * 主窗口与外部链接的导航规则(纯函数,方便测试;接线在 desktopWindowChrome / desktopMainIpcRemote)。
 *
 * 主窗口带完整 preload(window.zcode、Host 的 MessagePort、leoLink),不能被导航到别的页面,
 * 也不能用 window.open 开出继承同一 preload 的子窗口去加载网页。
 */

/**
 * `file:` 交给 shell.openExternal 会直接启动 .app / .command,只允许应用自己的窗口发起;
 * 内嵌网页(webview 访客,含远端页面的 preload 桥)只能开 http(s)。
 */
export function isAllowedExternalOpenUrl(value: string, fromWebviewGuest = false): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return true;
    return url.protocol === "file:" && !fromWebviewGuest;
  } catch {
    return false;
  }
}

/** 同一份应用页面(同源、同路径;只换查询参数或 hash,比如切换本机 / 服务器工作台)才放行。 */
export function isSameAppDocument(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      current.protocol === target.protocol &&
      current.host === target.host &&
      current.pathname === target.pathname
    );
  } catch {
    return false;
  }
}

/** window.open 的目标:http(s) 交给系统浏览器,其它一律不开。 */
export function externalUrlForWindowOpen(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
