import os from "node:os";

import type { LinkResponse } from "./bridge.js";
import type { Caller } from "./session.js";

/** 会话 id 就是任务 id:只允许普通字符,挡掉编码后的 `/`、`..` 这类路径花样。 */
export function validSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !id.includes("/") && !id.includes("..") && !/[\\\s]/.test(id);
}

/**
 * 经 Leo Link 只放行手机协议 v0.4 这几条;模型代理(/v1/models、/v1/chat/completions)、
 * 藏宝阁(/api/leo/*)、机器人配置一律拒绝 —— 它们只给本机用。
 */
export function isLinkPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/v1/capabilities" ||
    pathname === "/v1/grok/token" ||
    pathname === "/harness/full-auto" ||
    pathname === "/harness/sessions" ||
    /^\/harness\/sessions\/[^/]+\/(events|send|approval|stop|archive)$/.test(pathname)
  );
}

export function error(status: number, message: string): LinkResponse {
  return { status, body: { error: { message } } };
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function expandHome(input: string): string {
  return input.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * [A3] 认不出调用方时的 403:message 照旧给老客户端显示,code / fix / steps 给手机渲染修复步骤。
 * 只有中继 0.2 起才在转发里带上调用方,手机重新登记设备钥匙解决不了,所以 fix 固定是 mac_steps。
 * 与 src/mac/leoagent/server.py 的 device_not_recognized 同一份契约。
 */
export const DEVICE_NOT_RECOGNIZED_STEPS = [
  "在运行中继的那台 Mac 上,把中继(relay.py)更新到 0.2 或更新版本并重启中继。",
  "在这台 Mac 上把 LeoPhoneAgent(或 leoagent)更新到最新版,确认它重新连上了中继。",
  "回到手机重发这个任务,全自动就会生效。",
];

export function deviceNotRecognized(message: string): LinkResponse {
  return {
    status: 403,
    body: {
      error: { message, code: "device_not_recognized", fix: "mac_steps", steps: DEVICE_NOT_RECOGNIZED_STEPS },
    },
  };
}

/** 认得出是哪台设备(iPhone、安卓、鸿蒙、主钥匙)就能开或切全自动;中继 0.1 认不出是谁,不行。 */
export function mayUseFullAuto(caller: Caller): boolean {
  return caller.kind !== "unknown";
}
