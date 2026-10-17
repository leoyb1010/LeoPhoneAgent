import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, desktopCapturer, screen, systemPreferences } from "electron";

import { handlePeerRequest, type PeerRequest } from "./screenMediaHandler.js";

/**
 * [leo][WP-50] 看屏 R0 的截图端(契约见 docs/specs/leo-screen.md)。
 *
 * desktopCapturer 只能在主进程用,所以主进程开一个只在本机的 unix socket(0600)给 Host 取帧:
 * 地址与本次启动的口令经 fork 环境交给 Host。这里不做任何策略(开关、scope、限频都在 Host),
 * 也从不主动申请屏幕录制权限 —— 没权限就回 428,由设置页引导用户去系统设置。
 */

const SOCKET_PATH = join(tmpdir(), `leo-screen-${process.pid}.sock`);
const SECRET = randomBytes(24).toString("base64url");
export const SCREEN_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

let server: Server | null = null;
type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

const digest = (value: string) => createHash("sha256").update(value).digest();
const secretMatches = (candidate: unknown) =>
  typeof candidate === "string" && timingSafeEqual(digest(candidate), digest(SECRET));

export function screenPermissionStatus(): string {
  return process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("screen")
    : "unsupported";
}

type Frame = { jpeg: Buffer; width: number; height: number; displayId: string; capturedAt: number };
type CaptureError = { status: number; code: string; message: string };

async function captureScreenFrame(options: {
  maxEdge: number;
  quality: number;
  displayId?: string;
}): Promise<Frame | CaptureError> {
  if (screenPermissionStatus() !== "granted") {
    return { status: 428, code: "screen_permission", message: "Mac 上还没允许 LeoBot 录制屏幕" };
  }
  const displays = screen.getAllDisplays();
  const target = options.displayId
    ? displays.find((display) => String(display.id) === options.displayId)
    : screen.getPrimaryDisplay();
  if (!target) return { status: 404, code: "display_not_found", message: "没有这块屏幕" };
  // 缩略图按给定框等比缩放:框取长边上限的正方形,得到的图长边就是 maxEdge(不放大)。
  const nativeLongEdge = Math.max(target.size.width, target.size.height) * target.scaleFactor;
  const edge = Math.max(1, Math.min(Math.round(options.maxEdge), Math.round(nativeLongEdge)));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: edge, height: edge },
    fetchWindowIcons: false,
  });
  const source =
    sources.find((item) => item.display_id === String(target.id)) ??
    (options.displayId ? undefined : sources[0]);
  if (!source || source.thumbnail.isEmpty()) {
    return { status: 503, code: "capture_unavailable", message: "这次没截到屏幕" };
  }
  const size = source.thumbnail.getSize();
  return {
    jpeg: source.thumbnail.toJPEG(Math.round(Math.min(0.9, Math.max(0.3, options.quality)) * 100)),
    width: size.width,
    height: size.height,
    displayId: String(target.id),
    capturedAt: Date.now(),
  };
}

function ensureServer(logger: Logger): void {
  if (server || process.platform !== "darwin") return;
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // 上次没清掉的同名 socket(同 pid 的概率极低);不存在是常态。
  }
  server = createServer((req, res) => {
    if (
      req.method !== "POST" ||
      (req.url !== "/capture" && req.url !== "/peer") ||
      !secretMatches(req.headers["x-leo-screen"])
    ) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    if (req.url === "/peer") {
      // [WP-51] R1 信令里需要主进程做的那部分(采屏 + PeerConnection),见 screenMediaHandler.ts。
      req.on("end", () => {
        void (async () => {
          let request: PeerRequest = { op: "status" };
          try {
            request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PeerRequest;
          } catch {
            // 坏请求按查询状态处理。
          }
          const result =
            request.op === "open" && screenPermissionStatus() !== "granted"
              ? {
                  status: 428,
                  body: { code: "screen_permission", message: "Mac 上还没允许 LeoBot 录制屏幕" },
                }
              : await handlePeerRequest(request, logger);
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
        })();
      });
      return;
    }
    req.on("end", () => {
      void (async () => {
        let options: { maxEdge?: unknown; quality?: unknown; displayId?: unknown } = {};
        try {
          options = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof options;
        } catch {
          // 坏请求按默认参数截。
        }
        const result = await captureScreenFrame({
          maxEdge: typeof options.maxEdge === "number" ? options.maxEdge : 1280,
          quality: typeof options.quality === "number" ? options.quality : 0.6,
          ...(typeof options.displayId === "string" ? { displayId: options.displayId } : {}),
        });
        if ("jpeg" in result) {
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "x-width": result.width,
            "x-height": result.height,
            "x-display-id": result.displayId,
            "x-captured-at": result.capturedAt,
          });
          res.end(result.jpeg);
        } else {
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: result.code, message: result.message }));
        }
      })().catch((error: unknown) => {
        logger.warn("[leo-screen] capture failed", error);
        if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "capture_unavailable", message: "截屏失败" }));
      });
    });
  });
  server.listen(SOCKET_PATH, () => {
    try {
      chmodSync(SOCKET_PATH, 0o600);
    } catch (error) {
      logger.warn("[leo-screen] chmod socket failed", error);
    }
  });
  server.on("error", (error) => logger.warn("[leo-screen] capture socket failed", error));
  app.on("will-quit", () => {
    server?.close();
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // 已经没了。
    }
  });
}

/** 交给 Host 的环境变量(fork 时合进去);第一次调用时顺手把 socket 开起来。 */
export function leoScreenHostEnv(logger: Logger = console): Record<string, string> {
  if (process.platform !== "darwin") return {};
  ensureServer(logger);
  return { LEO_SCREEN_SOCKET: SOCKET_PATH, LEO_SCREEN_SECRET: SECRET };
}
