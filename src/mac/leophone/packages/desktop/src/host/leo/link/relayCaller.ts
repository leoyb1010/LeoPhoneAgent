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

