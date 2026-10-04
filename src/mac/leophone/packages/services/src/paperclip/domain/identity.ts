export function normalizePaperclipOrigin(value: string): string {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("请输入 HTTPS 服务器根地址；HTTP 仅限本机开发，不能含凭据或子路径。");
  }
  return url.origin;
}
export function paperclipIdentityKey(origin: string, userId: string, companyId = ""): string {
  return JSON.stringify([origin, userId, companyId]);
}
export function paperclipId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("服务器标识格式不兼容。");
  return value;
}
export function creationRetryPermitted(firstSubmittedAt: number, now = Date.now()): boolean {
  const age = now - firstSubmittedAt;
  return Number.isFinite(age) && age >= 0 && age < 7 * 24 * 60 * 60 * 1000;
}
