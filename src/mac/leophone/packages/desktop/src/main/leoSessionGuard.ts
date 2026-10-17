import { session } from "electron";
import type { OnBeforeRequestListenerDetails } from "electron";
import { isLeoBlockedHost } from "@zcode/shared/leo-network-guard";
import { blockBeforeRequest } from "./observeBeforeRequest.js";

/** 拦截覆盖的协议：http / https / ws / wss（含 WebSocket 升级请求）。 */
export const LEO_SESSION_GUARD_URLS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];

/** 请求是否指向官方服务（z.ai / bigmodel / zhipu / chatglm / codegeex / zcode.ai）。 */
export function isLeoBlockedRequest(details: Pick<OnBeforeRequestListenerDetails, "url">): boolean {
  try {
    return isLeoBlockedHost(new URL(details.url).hostname);
  } catch {
    return false;
  }
}

/**
 * [leo] 界面侧(Chromium 网络栈:渲染进程的 fetch / 图片 / 链接预取,以及 main 的 net.fetch)
 * 不走 Node 的 DNS,单独在默认 session 上拦一次。内置浏览器用独立 partition,用户自己浏览不受影响。
 *
 * 3.15.1 起 defaultSession 的 onBeforeRequest 由 `observeBeforeRequest.ts` 统一分发
 * (资源管理器抓包开 / 关会重装、清除监听),所以这里登记成「拦截者」而不是直接注册监听,
 * 抓包开关都不会把拦截顶掉。插件 UI 沙箱分区(`persist:plugin-sandbox-v1-*`)有自己的
 * onBeforeRequest,拦截写在 `pluginSandbox/session.ts` 里(同样调用 `isLeoBlockedRequest`)。
 */
export function installLeoSessionGuard(): () => void {
  return blockBeforeRequest(
    session.defaultSession.webRequest,
    LEO_SESSION_GUARD_URLS,
    isLeoBlockedRequest,
  );
}
