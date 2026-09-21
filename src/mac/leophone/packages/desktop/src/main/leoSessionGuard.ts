import { session } from "electron";
import { isLeoBlockedHost } from "@zcode/shared/leo-network-guard";

/**
 * [leo] 界面侧(Chromium 网络栈:渲染进程的 fetch / 图片 / 链接预取,以及 main 的 net.fetch)
 * 不走 Node 的 DNS,单独在默认 session 上拦一次。内置浏览器用独立 partition,用户自己浏览不受影响。
 */
export function installLeoSessionGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let blocked = false;
    try {
      blocked = isLeoBlockedHost(new URL(details.url).hostname);
    } catch {
      blocked = false;
    }
    callback(blocked ? { cancel: true } : {});
  });
}
