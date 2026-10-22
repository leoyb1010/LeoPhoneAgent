import type { Caller, CallerKind } from "./session.js";

const CALLER_KINDS = new Set<CallerKind>(["iphone", "legacy", "master"]);
/** 中继 0.2 转发时附带调用方;0.1 没有,记成 unknown。 */
export function callerFrom(frame: Record<string, unknown>): Caller {
  const raw = frame["caller"];
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const obj = raw as Record<string, unknown>;
  const kind = String(obj["kind"] ?? "") as CallerKind;
  return {
    kind: CALLER_KINDS.has(kind) ? kind : "unknown",
    ...(obj["device_id"] ? { deviceId: String(obj["device_id"]) } : {}),
    ...(obj["name"] ? { name: String(obj["name"]) } : {}),
  };
}

/**
 * [up-c-mac] 链路追踪号:中继帧的 trace_id;中继若改为原样转发请求头,也认 headers 里的 X-Leo-Trace-Id。
 * 格式由 LinkBridge 再校验。
 */
export function traceIdOf(frame: Record<string, unknown>): string | undefined {
  if (typeof frame["trace_id"] === "string" && frame["trace_id"]) return frame["trace_id"];
  const headers = frame["headers"];
  if (!headers || typeof headers !== "object") return undefined;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>))
    if (name.toLowerCase() === "x-leo-trace-id" && typeof value === "string" && value) return value;
  return undefined;
}
