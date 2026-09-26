import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

/**
 * [leo-link] 「连接手机」面板的通道:界面 → 主进程 → 本机 Leo 接口(带 Bearer)。
 *
 * 界面是 file:// 页面,直接跨域调 127.0.0.1 要么被拦、要么只能对 Origin: null 开 CORS
 * (网页里的沙箱 iframe 也是 null,等于把配对码开放给任意网站);走主进程转发就没有这个口子。
 * 只认应用自己的顶层页面,内嵌浏览器、iframe 调不到。
 */
export const LEO_LINK_STATUS_CHANNEL = "leo:link:status";
export const LEO_LINK_PAIR_CHANNEL = "leo:link:pair";

export type LeoLinkIpcResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// 与 host/leo/leoPaths.ts 同一套约定(主进程不引 host 的模块):端口 38473,钥匙 ~/.leoagent/key。
const LEO_HTTP_PORT = Number(process.env["LEOAGENT_PORT"]) || 38473;

function leoLocalKey(): string | null {
  const envKey = process.env["LEOAGENT_KEY"]?.trim();
  if (envKey) return envKey;
  const home = process.env["LEOAGENT_HOME"]?.trim() || join(homedir(), ".leoagent");
  try {
    const key = readFileSync(join(home, "key"), "utf8").trim();
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  const url = frame.url ?? "";
  if (url.startsWith("file://")) return true;
  // 开发态界面由本机 Vite 提供。
  return !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url);
}

async function callLeo(path: string, method: "GET" | "POST"): Promise<LeoLinkIpcResult> {
  const key = leoLocalKey();
  if (!key) return { ok: false, error: "本机 Leo 服务还没启动" };
  try {
    const res = await fetch(`http://127.0.0.1:${LEO_HTTP_PORT}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(25_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}` };
    }
    return { ok: true, data: body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerLeoLinkIpc(): void {
  ipcMain.handle(LEO_LINK_STATUS_CHANNEL, (event) =>
    trustedSender(event) ? callLeo("/api/leo/link/status", "GET") : { ok: false, error: "forbidden" },
  );
  ipcMain.handle(LEO_LINK_PAIR_CHANNEL, (event) =>
    trustedSender(event) ? callLeo("/api/leo/link/pair", "POST") : { ok: false, error: "forbidden" },
  );
}
