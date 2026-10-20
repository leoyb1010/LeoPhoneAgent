import { randomBytes } from "node:crypto";
import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import { callLeo, LEO_HTTP_PORT, leoOAuthPageUrl, ownHostListening } from "./leoLinkHttp.js";
import {
  leoScreenHostEnv,
  SCREEN_PRIVACY_URL,
  screenPermissionStatus,
} from "./leo/screenCapture.js";
import {
  accessibilityGranted,
  inputHelperAvailable,
  openAccessibilitySettings,
  startScreenInput,
} from "./leo/screenInput.js";

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
  // [WP-50] 看屏截图 socket 的地址与口令也经 fork 环境交给 Host(见 leo/screenCapture.ts)。
  return { [LEO_PAIR_SECRET_ENV]: LEO_PAIR_SECRET, LEO_UI_SECRET, ...leoScreenHostEnv() };
}

export function isTrustedLeoSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  // 只认应用窗口自己的页面:内嵌浏览器(webview 访客)里打开的本地 HTML 也是 file://。
  if (event.sender.getType() !== "window") return false;
  const url = frame.url ?? "";
  if (url.startsWith("file://")) return true;
  // 开发态界面由本机 Vite 提供。
  return !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url);
}

/**
 * [leo] 菜单栏 / 快速派发调 Host:与出配对码一样要带内存口令(见 docs/specs/leo-quick-entry.md),
 * 只有主进程能调;端口上不是我们自己的 Host 时口令不外交。
 */
export async function callLeoQuick(
  path: "/api/leo/quick/summary" | "/api/leo/quick/dispatch",
  body?: unknown,
): Promise<import("./leoLinkHttp.js").LeoLinkIpcResult> {
  if (!(await ownHostListening())) return { ok: false, error: "本机 Leo 服务还没启动" };
  return callLeo(
    path,
    body === undefined ? "GET" : "POST",
    { "x-leo-pair": LEO_PAIR_SECRET },
    body,
  );
}

/**
 * [leo][WP-27] 并行任务组调 Host:同快速派发,要内存口令。建组要建 worktree、跑 leo.json 的 setup,
 * 采纳 / 清理要动 git,给足时间。
 */
export async function callLeoGroups(
  action: "list" | "create" | "diff" | "merge" | "cleanup",
  body?: unknown,
): Promise<import("./leoLinkHttp.js").LeoLinkIpcResult> {
  if (!(await ownHostListening())) return { ok: false, error: "本机 Leo 服务还没启动" };
  return callLeo(
    `/api/leo/groups/${action}`,
    action === "list" ? "GET" : "POST",
    { "x-leo-pair": LEO_PAIR_SECRET },
    action === "list" ? undefined : (body ?? {}),
    15 * 60_000,
  );
}

const PORT_TAKEN = `本机端口 ${LEO_HTTP_PORT} 被别的程序占着(比如旧版 LeoCodeBox),先关掉它再试`;

/** [WP-50] 设置「连接手机 → 屏幕」:开关在 Host(要内存口令),屏幕录制权限状态在主进程。 */
/** [WP-50/51/52] 看屏三个开关:enabled / tailnet_only / control;patch 为空就是读取。 */
type ScreenPatch = { enabled?: boolean; tailnet_only?: boolean; control?: boolean };

function screenPatch(value: unknown): ScreenPatch | null {
  // 旧调用只传一个布尔值 = 「允许手机查看屏幕」。
  if (typeof value === "boolean") return { enabled: value };
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const patch: ScreenPatch = {};
  for (const key of ["enabled", "tailnet_only", "control"] as const)
    if (typeof raw[key] === "boolean") patch[key] = raw[key];
  return Object.keys(patch).length > 0 ? patch : null;
}

async function screenShareState(patch?: ScreenPatch) {
  // 注入助手缺失时打开操控也没用：不让打开（关掉照常可以）。
  const inputHelper = inputHelperAvailable();
  if (patch?.control === true && !inputHelper) {
    delete patch.control;
    if (Object.keys(patch).length === 0) patch = undefined;
  }
  const host = (await ownHostListening())
    ? await callLeo(
        "/api/leo/link/screen",
        patch === undefined ? "GET" : "POST",
        { "x-leo-pair": LEO_PAIR_SECRET },
        patch,
      )
    : ({ ok: false, error: "本机 Leo 服务还没启动" } as const);
  return {
    enabled: host.ok ? host.data["enabled"] === true : false,
    tailnetOnly: host.ok ? host.data["tailnet_only"] === true : false,
    control: host.ok ? host.data["control"] === true : false,
    hostError: host.ok ? null : host.error,
    permission: screenPermissionStatus(),
    // [WP-52] 操控要给 LeoBot「辅助功能」授权(注入与 Esc×3 监听都要)。
    accessibility: accessibilityGranted(),
    inputHelper,
  };
}

export function registerLeoLinkIpc(): void {
  // [WP-52] 视频会话打开输入通道时拉起 leo-input、亮菜单栏红点。
  startScreenInput(console);
  ipcMain.handle("leo:screen:open-accessibility", async (event) => {
    if (!isTrustedLeoSender(event)) return false;
    await openAccessibilitySettings();
    return true;
  });
  ipcMain.handle("leo:screen:status", (event) =>
    isTrustedLeoSender(event) ? screenShareState() : { error: "forbidden" },
  );
  ipcMain.handle("leo:screen:set", (event, value: unknown) => {
    const patch = screenPatch(value);
    return isTrustedLeoSender(event) && patch ? screenShareState(patch) : { error: "forbidden" };
  });
  ipcMain.handle("leo:screen:open-settings", async (event) => {
    if (!isTrustedLeoSender(event)) return false;
    await shell.openExternal(SCREEN_PRIVACY_URL);
    return true;
  });
  ipcMain.handle(LEO_OAUTH_OPEN_CHANNEL, async (event) => {
    if (!isTrustedLeoSender(event)) return { ok: false, error: "forbidden" };
    // 端口上不是我们的 Host(旧版 LeoCodeBox 等)时,带口令的地址不能交给它的页面。
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    await shell.openExternal(leoOAuthPageUrl(LEO_HTTP_PORT, LEO_UI_SECRET));
    return { ok: true, data: {} };
  });
  ipcMain.handle("leo:link:direct", async (event, action: unknown, body: unknown) => {
    if (!isTrustedLeoSender(event) || !["pair", "configure", "revoke"].includes(String(action)))
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
    isTrustedLeoSender(event)
      ? callLeo("/api/leo/link/status", "GET")
      : { ok: false, error: "forbidden" },
  );
  ipcMain.handle(LEO_LINK_PAIR_CHANNEL, async (event) => {
    if (!isTrustedLeoSender(event)) return { ok: false, error: "forbidden" };
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    return callLeo("/api/leo/link/pair", "POST", { "x-leo-pair": LEO_PAIR_SECRET });
  });
  ipcMain.handle(LEO_LINK_REVOKE_CHANNEL, async (event, payload: unknown) => {
    if (!isTrustedLeoSender(event) || typeof payload !== "string")
      return { ok: false, error: "forbidden" };
    if (!(await ownHostListening())) return { ok: false, error: PORT_TAKEN };
    return callLeo(`/api/leo/link/pair?payload=${encodeURIComponent(payload)}`, "DELETE", {
      "x-leo-pair": LEO_PAIR_SECRET,
    });
  });
}
