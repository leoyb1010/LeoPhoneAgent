import { request } from "node:http";
import { readFile } from "node:fs/promises";

import { leoPath } from "../../leoPaths.js";
import { writeDurableJson } from "../durableJson.js";
import type { CaptureOptions, CaptureResult } from "./snapshot.js";

/**
 * [leo][WP-50] Host → 主进程取一帧屏幕。desktopCapturer 只能在主进程用;主进程为此开了一个只在本机
 * 的 unix socket,地址与本次启动的口令经 fork 环境交给 Host(模块加载时就从环境里抹掉,子进程继承不到)。
 */
const SOCKET = process.env["LEO_SCREEN_SOCKET"]?.trim() ?? "";
const SECRET = process.env["LEO_SCREEN_SECRET"]?.trim() ?? "";
delete process.env["LEO_SCREEN_SOCKET"];
delete process.env["LEO_SCREEN_SECRET"];

const unavailable = (message: string): CaptureResult => ({
  ok: false,
  status: 503,
  code: "capture_unavailable",
  message,
});

export function captureViaMain(options: CaptureOptions): Promise<CaptureResult> {
  if (!SOCKET || !SECRET)
    return Promise.resolve(unavailable("截屏服务没有启动(不是 LeoBot 主进程拉起的 Host)"));
  const payload = JSON.stringify(options);
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: SOCKET,
        path: "/capture",
        method: "POST",
        headers: { "content-type": "application/json", "x-leo-screen": SECRET },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode === 200) {
            resolve({
              ok: true,
              frame: {
                jpeg: body,
                width: Number(res.headers["x-width"]) || 0,
                height: Number(res.headers["x-height"]) || 0,
                displayId: String(res.headers["x-display-id"] ?? ""),
                capturedAt: Number(res.headers["x-captured-at"]) || Date.now(),
              },
            });
            return;
          }
          try {
            const error = JSON.parse(body.toString("utf8")) as { code?: string; message?: string };
            resolve({
              ok: false,
              status: res.statusCode ?? 503,
              code: error.code ?? "capture_unavailable",
              message: error.message ?? "截屏失败",
            });
          } catch {
            resolve(unavailable(`截屏失败(HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(unavailable(`截屏服务不可用:${error.message}`)));
    req.end(payload);
  });
}

/** [WP-51] R1 信令里主进程那一半(采屏 + PeerConnection):POST /peer,回 {status, body}。 */
export function peerViaMain(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (!SOCKET || !SECRET)
    return Promise.resolve({
      status: 503,
      body: {
        code: "capture_unavailable",
        message: "看屏服务没有启动(不是 LeoBot 主进程拉起的 Host)",
      },
    });
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: SOCKET,
        path: "/peer",
        method: "POST",
        headers: { "content-type": "application/json", "x-leo-screen": SECRET },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = { code: "capture_unavailable", message: "看屏服务回了看不懂的内容" };
          }
          resolve({ status: res.statusCode ?? 503, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) =>
      resolve({
        status: 503,
        body: { code: "capture_unavailable", message: `看屏服务不可用:${error.message}` },
      }),
    );
    req.end(JSON.stringify(payload));
  });
}

/** 关掉「查看」或「操控」开关时立刻断开正在进行的视频会话,不等它自己超时。 */
export async function closeAllScreenSessions(): Promise<void> {
  const status = await peerViaMain({ op: "status" });
  const sessions = (status.body as { sessions?: { id?: unknown }[] } | null)?.sessions ?? [];
  for (const entry of sessions)
    if (typeof entry.id === "string") await peerViaMain({ op: "close", sessionId: entry.id });
}

/**
 * 看屏设置,存在 ~/.leoagent/link/screen.json,全部默认关:
 * - enabled:「允许手机查看屏幕」(R0 截图与 R1 视频共用);
 * - tailnetOnly:[WP-51]「只走 Tailscale」—— 视频只用 tailnet 候选,不用局域网 / STUN / 中转;
 * - control:[WP-52]「允许手机操控」(scope screen.control)。
 */
export interface ScreenSettings {
  enabled: boolean;
  tailnetOnly: boolean;
  control: boolean;
}

const SETTINGS_FILE = () => leoPath("link", "screen.json");
let cached: ScreenSettings | null = null;

export async function screenSettings(): Promise<ScreenSettings> {
  if (cached) return cached;
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(await readFile(SETTINGS_FILE(), "utf8")) as Record<string, unknown>;
  } catch {
    // 没有文件 = 全关。
  }
  cached = {
    enabled: value["enabled"] === true,
    tailnetOnly: value["tailnet_only"] === true,
    control: value["control"] === true,
  };
  return cached;
}

/** POST /api/leo/link/screen 的正文 → 设置补丁;一个布尔字段都没有就是 null。 */
export function parseScreenSettingsPatch(
  body: Record<string, unknown>,
): Partial<ScreenSettings> | null {
  const patch: Partial<ScreenSettings> = {};
  if (typeof body["enabled"] === "boolean") patch.enabled = body["enabled"];
  if (typeof body["tailnet_only"] === "boolean") patch.tailnetOnly = body["tailnet_only"];
  if (typeof body["control"] === "boolean") patch.control = body["control"];
  return Object.keys(patch).length > 0 ? patch : null;
}

export const screenSettingsBody = (settings: ScreenSettings) => ({
  enabled: settings.enabled,
  tailnet_only: settings.tailnetOnly,
  control: settings.control,
});

export async function screenSharingEnabled(): Promise<boolean> {
  return (await screenSettings()).enabled;
}

export async function updateScreenSettings(
  patch: Partial<ScreenSettings>,
): Promise<ScreenSettings> {
  const next = { ...(await screenSettings()), ...patch };
  await writeDurableJson(SETTINGS_FILE(), {
    version: 2,
    enabled: next.enabled,
    tailnet_only: next.tailnetOnly,
    control: next.control,
  });
  cached = next;
  return next;
}

/** [WP-51] Mac mini coturn 的配置(~/.leoagent/link/turn.json,含共享密钥,只有 Mac 读)。 */
export async function readTurnConfigFile(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(leoPath("link", "turn.json"), "utf8"));
  } catch {
    return null;
  }
}
