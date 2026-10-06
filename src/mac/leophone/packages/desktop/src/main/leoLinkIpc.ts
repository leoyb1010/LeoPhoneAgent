import { randomBytes } from "node:crypto";
import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import { callLeo, LEO_HTTP_PORT, leoOAuthPageUrl, ownHostListening } from "./leoLinkHttp.js";

/**
 * [leo-link] 「连接手机」面板的通道:界面 → 主进程 → 本机 Leo 接口(带 Bearer)。
 *
 * 界面是 file:// 页面,直接跨域调 127.0.0.1 要么被拦、要么只能对 Origin: null 开 CORS
 * (网页里的沙箱 iframe 也是 null,等于把配对码开放给任意网站);走主进程转发就没有这个口子。
 * 只认应用自己的顶层页面,内嵌浏览器、iframe 调不到。
 */
export const LEO_LINK_STATUS_CHANNEL = "leo:link:status";
export const LEO_LINK_PAIR_CHANNEL = "leo:link:pair";
export const LEO_LINK_REVOKE_CHANNEL = "leo:link:revoke";

export type { LeoLinkIpcResult } from "./leoLinkHttp.js";

/**
 * 出配对码的口令:每次启动在主进程内存里随机生成,只经 fork 环境交给 Host(Host 启动即从
 * 环境里抹掉)。`~/.leoagent/key` 谁都读得到,agent 拿着它也签不出配对码 —— 必须是用户在
 * 界面上点了「扫码连接手机」、经这条 IPC 才行。
 */
const LEO_PAIR_SECRET = randomBytes(24).toString("base64url");
export const LEO_PAIR_SECRET_ENV = "LEO_PAIR_SECRET";

/**
 * 订阅登录页接口的口令:同样每次启动随机生成、只交给我们自己的 Host。主进程打开登录页时把它放进
 * URL 片段(#t=…,不发给服务器、不进日志),页面用它调登录 / 退出接口;本机别的进程拿不到。
 */
const LEO_UI_SECRET = randomBytes(24).toString("base64url");
export const LEO_OAUTH_OPEN_CHANNEL = "leo:oauth:open";

export function leoHostPairEnv(): Record<string, string> {
  return { [LEO_PAIR_SECRET_ENV]: LEO_PAIR_SECRET, LEO_UI_SECRET };
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  // 只认应用窗口自己的页面:内嵌浏览器(webview 访客)里打开的本地 HTML 也是 file://。
  if (event.sender.getType() !== "window") return false;
  const url = frame.url ?? "";
  if (url.startsWith("file://")) return true;
  // 开发态界面由本机 Vite 提供。
  return !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url);
}

const PORT_TAKEN = `本机端口 ${LEO_HTTP_PORT} 被别的程序占着(比如旧版 LeoCodeBox),先关掉它再试`;

export function registerLeoLinkIpc(): void {
  ipcMain.handle(LEO_OAUTH_OPEN_CHANNEL, async (event) => {
    if (!trustedSender(event)) return { ok: false, error: "forbidden" };
    // 端口上不是我们的 Host(旧版 LeoCodeBox 等)时,带口令的地址不能交给它的页面。
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    await shell.openExternal(leoOAuthPageUrl(LEO_HTTP_PORT, LEO_UI_SECRET));
    return { ok: true, data: {} };
  });
  ipcMain.handle("leo:link:direct", async (event, action: unknown, body: unknown) => {
    if (!trustedSender(event) || !["pair", "configure", "revoke"].includes(String(action)))
      return { ok: false, error: "forbidden" };
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    return callLeo(
      `/api/leo/link/direct/${String(action)}`,
      "POST",
      { "x-leo-pair": LEO_PAIR_SECRET },
      body,
    );
  });
  ipcMain.handle(LEO_LINK_STATUS_CHANNEL, (event) =>
    trustedSender(event)
      ? callLeo("/api/leo/link/status", "GET")
      : { ok: false, error: "forbidden" },
  );
  ipcMain.handle(LEO_LINK_PAIR_CHANNEL, async (event) => {
    if (!trustedSender(event)) return { ok: false, error: "forbidden" };
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    return callLeo("/api/leo/link/pair", "POST", { "x-leo-pair": LEO_PAIR_SECRET });
  });
  ipcMain.handle(LEO_LINK_REVOKE_CHANNEL, async (event, payload: unknown) => {
    if (!trustedSender(event) || typeof payload !== "string")
      return { ok: false, error: "forbidden" };
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    return callLeo(`/api/leo/link/pair?payload=${encodeURIComponent(payload)}`, "DELETE", {
      "x-leo-pair": LEO_PAIR_SECRET,
    });
  });
}
