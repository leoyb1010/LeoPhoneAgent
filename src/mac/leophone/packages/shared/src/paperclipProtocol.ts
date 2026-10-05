/**
 * Paperclip 协议真相源：Main 网络边界、服务层与 UI 共用同一份规则，避免各层各写一份后漂移。
 * 本文件不依赖 zod 或 Node/Electron，Electron 回归夹具与独立传输类型检查可以直接转译它。
 * 服务器真值来自上游 994d6edc 的 ISSUE_STATUSES / ISSUE_PRIORITIES /
 * ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS；iOS 端 Contract.swift 与此保持一致。
 */

/** HTTP 只允许这些显式本机 loopback 主机名，用于本机开发。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type PaperclipOriginRejection = "malformed" | "insecure" | "not-origin";

/**
 * 规范化服务器 origin：HTTPS；HTTP 仅限 loopback；不得含凭据、子路径、查询或 fragment。
 * URL.origin 已把主机名转小写并去掉默认端口（443/80），与 iOS 的归一规则一致。
 * 只返回原因码，错误文案由各层按自身场景给出。
 */
export function parsePaperclipOrigin(
  value: string,
): { origin: string } | { rejection: PaperclipOriginRejection } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { rejection: "malformed" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    return { rejection: "insecure" };
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    return { rejection: "not-origin" };
  return { origin: url.origin };
}

/** 服务器资源标识（公司、任务、运行、审批、附件等）允许的字符，供路由正则拼接。 */
export const PAPERCLIP_ID_PATTERN = "[A-Za-z0-9_-]+";

export function isPaperclipId(value: string): boolean {
  return new RegExp(`^${PAPERCLIP_ID_PATTERN}$`).test(value);
}

/** 上游 ISSUE_STATUSES。 */
export const PAPERCLIP_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;

/** 上游 ISSUE_PRIORITIES；服务器没有 urgent，最高级是 critical。 */
export const PAPERCLIP_ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;

/** 上游 ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS：服务器只在这段时间内按 idempotencyKey 去重。 */
const PAPERCLIP_CREATE_IDEMPOTENCY_RETENTION_DAYS = 7;

/**
 * 客户端允许重试同一创建的窗口比服务器保留期少 1 天：
 * 余量覆盖本机与服务器时钟偏差及服务器清理任务的执行时机，避免临界重试被当成新任务重复创建。
 * 与 iOS PaperclipDraft 的 6 天窗口一致。
 */
export const PAPERCLIP_CREATE_RETRY_WINDOW_DAYS = PAPERCLIP_CREATE_IDEMPOTENCY_RETENTION_DAYS - 1;
const CREATE_RETRY_WINDOW_MS = PAPERCLIP_CREATE_RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** 首次提交时间必须可信（有限、不在未来）且仍在客户端重试窗口内。 */
export function paperclipCreateRetryPermitted(firstSubmittedAt: number, now = Date.now()): boolean {
  const age = now - firstSubmittedAt;
  return Number.isFinite(age) && age >= 0 && age < CREATE_RETRY_WINDOW_MS;
}
