import { createHash } from "node:crypto";

import type { Caller } from "../session.js";

/**
 * [leo][WP-50] R0 截图看屏的 Host 侧:开关、scope、ETag、中继限频与限大小。契约见 docs/specs/leo-screen.md。
 * 截图本身在主进程(desktopCapturer),这里通过注入的 capture 取帧;每次请求都现截一张,不存帧。
 */

export interface ScreenFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  displayId: string;
  capturedAt: number;
}

export type CaptureResult =
  | { ok: true; frame: ScreenFrame }
  | { ok: false; status: number; code: string; message: string };

export interface CaptureOptions {
  maxEdge: number;
  quality: number;
  displayId?: string;
}

export interface ScreenRequest {
  caller: Caller;
  transport: "direct" | "relay";
  query: URLSearchParams;
  ifNoneMatch?: string;
}

interface ScreenResponse {
  status: number;
  body: unknown;
  /** 直连返回原始 JPEG(directServer 直接写出);中继只能走 JSON。 */
  binary?: { data: Buffer; contentType: string };
  headers?: Record<string, string>;
}

const RELAY_MIN_INTERVAL_MS = 1_000;
const RELAY_MAX_BYTES = 200 * 1024;
const RELAY_MAX_EDGE = 1280;

function failure(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ScreenResponse {
  return { status, body: { error: { message, code }, ...extra } };
}

function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * screen.view:由调用方推出,不存进授权表。iPhone / iPad 经中继都按 iphone 登记;主钥匙也算;
 * 扫直连码配对的手机拿到的授权记作 legacy、设备号以 direct- 开头,也是 iPhone / iPad。
 * 中继上认不出设备钥匙的旧客户端(legacy 非 direct-)与 unknown 不行。
 */
export function mayViewScreen(caller: Caller): boolean {
  if (caller.kind === "iphone" || caller.kind === "master") return true;
  return caller.kind === "legacy" && Boolean(caller.deviceId?.startsWith("direct-"));
}

export function frameEtag(jpeg: Buffer): string {
  return `"${createHash("sha256").update(jpeg).digest("hex").slice(0, 32)}"`;
}

export function createScreenSnapshotService(deps: {
  capture: (options: CaptureOptions) => Promise<CaptureResult>;
  enabled: () => boolean | Promise<boolean>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const lastRelayServe = new Map<string, number>();

  return async function handle(req: ScreenRequest): Promise<ScreenResponse> {
    if (!(await deps.enabled()))
      return failure(
        403,
        "screen_disabled",
        "Mac 上没有打开「允许手机查看屏幕」(设置 → 连接手机 → 屏幕)",
      );
    if (!mayViewScreen(req.caller))
      return failure(403, "screen_scope_required", "这台设备没有查看屏幕的权限,请重新配对");
    const relay = req.transport === "relay";
    const display = req.query.get("display");
    if (display !== null && !/^\d{1,20}$/.test(display))
      return failure(404, "display_not_found", "没有这块屏幕");
    const ifNoneMatch = req.query.get("if_none_match") ?? req.ifNoneMatch;
    const format = req.query.get("format") === "json" || relay ? "json" : "jpeg";

    if (relay) {
      // 中继是单条 WS 文本通道,大帧会挡住审批事件:同一台设备 1 秒最多一张。
      const key = req.caller.deviceId ?? req.caller.kind;
      const last = lastRelayServe.get(key);
      const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now() - last;
      if (elapsed < RELAY_MIN_INTERVAL_MS) {
        return failure(429, "rate_limited", "看屏刷新太快了", {
          retry_after_ms: Math.ceil(RELAY_MIN_INTERVAL_MS - elapsed),
        });
      }
      lastRelayServe.set(key, now());
    }

    let options: CaptureOptions = {
      maxEdge: Math.round(
        clamp(req.query.get("max_edge"), 1280, 320, relay ? RELAY_MAX_EDGE : 2560),
      ),
      quality: clamp(req.query.get("q"), 0.6, 0.3, 0.9),
      ...(display !== null ? { displayId: display } : {}),
    };
    let result = await deps.capture(options);
    // 中继单帧不超过 200KB:超了降质量、缩边长各重来一次,最多两次。
    for (
      let attempt = 0;
      relay && result.ok && result.frame.jpeg.length > RELAY_MAX_BYTES && attempt < 2;
      attempt += 1
    ) {
      options = {
        ...options,
        quality: Math.max(0.3, options.quality * 0.7),
        maxEdge: Math.max(320, Math.round(options.maxEdge * 0.8)),
      };
      result = await deps.capture(options);
    }
    if (!result.ok) return failure(result.status, result.code, result.message);
    const { frame } = result;
    if (relay && frame.jpeg.length > RELAY_MAX_BYTES)
      return failure(413, "frame_too_large", "画面太大,中继传不了:请用直连或调小 max_edge");

    const etag = frameEtag(frame.jpeg);
    const headers = {
      etag,
      "x-leo-screen-width": String(frame.width),
      "x-leo-screen-height": String(frame.height),
      "x-leo-screen-display": frame.displayId,
      "x-leo-screen-captured-at": String(frame.capturedAt),
    };
    if (ifNoneMatch && ifNoneMatch === etag) {
      // 中继用 json_response 回给手机,真正的 304 带不了正文:中继路径用 200 + not_modified。
      return relay
        ? { status: 200, body: { etag, not_modified: true } }
        : { status: 304, body: null, headers };
    }
    if (format === "json") {
      return {
        status: 200,
        headers,
        body: {
          etag,
          content_type: "image/jpeg",
          width: frame.width,
          height: frame.height,
          display_id: frame.displayId,
          captured_at: frame.capturedAt,
          bytes: frame.jpeg.length,
          data_base64: frame.jpeg.toString("base64"),
        },
      };
    }
    return {
      status: 200,
      body: null,
      headers,
      binary: { data: frame.jpeg, contentType: "image/jpeg" },
    };
  };
}
