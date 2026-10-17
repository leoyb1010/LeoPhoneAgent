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

/** 「允许手机查看屏幕」开关,默认关。存在 ~/.leoagent/link/screen.json。 */
const SETTINGS_FILE = () => leoPath("link", "screen.json");
let cached: boolean | null = null;

export async function screenSharingEnabled(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const value = JSON.parse(await readFile(SETTINGS_FILE(), "utf8")) as { enabled?: unknown };
    cached = value.enabled === true;
  } catch {
    cached = false;
  }
  return cached;
}

export async function setScreenSharingEnabled(enabled: boolean): Promise<void> {
  await writeDurableJson(SETTINGS_FILE(), { version: 1, enabled });
  cached = enabled;
}
