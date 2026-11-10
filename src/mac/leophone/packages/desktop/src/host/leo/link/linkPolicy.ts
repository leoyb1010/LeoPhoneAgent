import os from "node:os";

import type { ZCodeTaskMode } from "@zcode/shared";

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
    pathname === "/harness/full-auto" ||
    pathname === "/harness/sessions" ||
    // [takeover] Mac 终端里的 Claude Code 会话(接管见 docs/specs/leo-link-takeover.md)。
    pathname === "/harness/external-sessions" ||
    // [remote-ctl-mac] 模型清单与会话操作(model/compact/rename/answer/follow),见 docs/specs/leo-link-remote-controls.md。
    pathname === "/harness/models" ||
    pathname === "/screen/snapshot" ||
    // [WP-51] R1 视频信令:/screen/session、/screen/session/<id>、/screen/session/<id>/ice。
    /^\/screen\/session(\/[^/]+(\/ice)?)?$/.test(pathname) ||
    // 权限模式 / 改动面板(changes、diff、revert)见 docs/specs/leo-link-changes.md。
    /^\/harness\/sessions\/[^/]+\/(events|send|approval|stop|archive|mode|changes|diff|revert|model|compact|rename|answer|follow)$/.test(pathname) ||
    // [fix-remote] 外部 agent 的远程登录：/agents/<key>/auth、/agents/<key>/login[/<flow>[/code|/cancel]]。
    /^\/agents\/[^/]+\/(auth|login(\/[^/]+(\/(code|cancel))?)?)$/.test(pathname) ||
    // [up-p3-mac] Mac 上的定时任务:/automations、/automations/<id>、/automations/<id>/run(docs/specs/leo-link-automations.md)。
    /^\/automations(\/[^/]+(\/run)?)?$/.test(pathname)
  );
}

/**
 * [leo] 只给本机用的凭据接口（契约见 docs/specs/desktop-renderer-boundary.md §3）。
 *
 * 根因：/v1/grok/token 原先在上面的白名单里，经中继能把 Mac 上 grok CLI 的真实 access token 拿到手机；
 * 直连入口单独拦了，中继入口没有。这里把路径规范化后统一判定，两个入口都在白名单之前调用：
 * 反复解百分号编码（防 %2F / %252F）、大小写不敏感、`\` 当 `/`、合并重复斜杠、解析 `.` 与 `..`、去尾斜杠。
 */
const LOCAL_ONLY_CREDENTIAL_PATHS = new Set(["/v1/grok/token"]);

export function canonicalLinkPath(pathname: string): string {
  let decoded = pathname;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function isLocalOnlyCredentialPath(pathname: string): boolean {
  return LOCAL_ONLY_CREDENTIAL_PATHS.has(canonicalLinkPath(pathname));
}

/**
 * [up-c-mac] Mac 的 IANA 时区(如 "Asia/Shanghai"):定时任务的计划按它解释,手机据此提示时区不一致。
 * 每次现取:用户改了系统时区不用重启 App。
 */
export function macTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
  "在运行中继的那台 Mac 上，把中继（relay.py）更新到 0.2 或更新版本并重启中继。",
  "在这台 Mac 上把 LeoBot（或 leoagent）更新到最新版，确认它重新连上了中继。",
  "回到手机重发这个任务，全自动就会生效。",
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

/** 手机能切的四种权限模式(iOS:先计划 / 自主 / 逐项确认 / 全自动)。 */
export const LINK_MODES = ["plan", "guarded", "build", "yolo"] as const satisfies readonly ZCodeTaskMode[];
export type LinkMode = (typeof LINK_MODES)[number];

export function linkMode(value: unknown): LinkMode | undefined {
  return LINK_MODES.find((mode) => mode === value);
}
