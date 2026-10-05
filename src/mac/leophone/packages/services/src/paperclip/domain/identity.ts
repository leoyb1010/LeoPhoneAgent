import { isPaperclipId, paperclipCreateRetryPermitted, parsePaperclipOrigin } from "@zcode/shared";

// origin、标识与创建重试窗口的规则统一来自 @zcode/shared 协议真相源；这里只保留服务层文案。
export function normalizePaperclipOrigin(value: string): string {
  const parsed = parsePaperclipOrigin(value);
  if ("origin" in parsed) return parsed.origin;
  throw new Error("请输入 HTTPS 服务器根地址；HTTP 仅限本机开发，不能含凭据或子路径。");
}
export function paperclipIdentityKey(origin: string, userId: string, companyId = ""): string {
  return JSON.stringify([origin, userId, companyId]);
}
export function paperclipId(value: string): string {
  if (!isPaperclipId(value)) throw new Error("服务器标识格式不兼容。");
  return value;
}
/** 客户端创建重试窗口为 6 天（服务器去重保留 7 天，留 1 天余量），见 shared/paperclipProtocol.ts。 */
export function creationRetryPermitted(firstSubmittedAt: number, now = Date.now()): boolean {
  return paperclipCreateRetryPermitted(firstSubmittedAt, now);
}
