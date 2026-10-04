/** Paperclip 原生边界：此处不读取 Cookie，也不允许 renderer 自定义认证头。 */
export interface NativePaperclipRequest {
  serverUrl: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export function canonicalPaperclipOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效的服务器地址");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("服务器地址格式不正确");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("远程服务器必须使用 HTTPS；HTTP 仅限本机开发");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("服务器地址只能包含协议、主机和端口，不能含凭据或子路径");
  }
  return url.origin;
}

const id = "[A-Za-z0-9_-]+";
const getPaths = [
  /^\/api\/(health|companies|auth\/get-session)$/,
  new RegExp(`^/api/companies/${id}/(issues|agents|approvals|heartbeat-runs|live-runs)$`),
  new RegExp(
    `^/api/issues/${id}(?:/(comments|runs|live-runs|active-run|execution|approvals|documents|attachments|work-products))?$`,
  ),
  new RegExp(`^/api/issues/${id}/documents/${id}$`),
  new RegExp(`^/api/heartbeat-runs/${id}(?:/(log|events))?$`),
  new RegExp(`^/api/approvals/${id}(?:/(comments|issues))?$`),
];
const postPaths = [
  new RegExp(`^/api/companies/${id}/issues$`),
  new RegExp(`^/api/issues/${id}/comments$`),
  new RegExp(`^/api/heartbeat-runs/${id}/cancel$`),
  new RegExp(`^/api/approvals/${id}/(approve|reject)$`),
];

export function validatePaperclipRequest(value: unknown): NativePaperclipRequest & { url: string } {
  if (!value || typeof value !== "object") throw new Error("无效的服务器请求");
  const input = value as NativePaperclipRequest;
  const origin = canonicalPaperclipOrigin(input.serverUrl);
  if (
    typeof input.path !== "string" ||
    input.path.length > 4096 ||
    !input.path.startsWith("/api/") ||
    /[%\\#]/.test(input.path.split("?")[0]!)
  ) {
    throw new Error("不允许访问该服务器路径");
  }
  const url = new URL(input.path, origin);
  if (url.origin !== origin || url.hash || url.pathname !== input.path.split("?")[0])
    throw new Error("不允许跨服务器请求");
  if (url.pathname === "/api/auth/get-session" && url.search)
    throw new Error("会话请求不能包含查询参数");
  const permitted =
    input.method === "GET"
      ? getPaths
      : input.method === "POST"
        ? postPaths
        : input.method === "PATCH"
          ? [new RegExp(`^/api/issues/${id}$`)]
          : [];
  if (!permitted.some((pattern) => pattern.test(url.pathname)))
    throw new Error("此服务器操作尚未开放");
  if (input.method === "GET" && input.body !== undefined) throw new Error("读取请求不能包含正文");
  if (input.body !== undefined && JSON.stringify(input.body).length > 1024 * 1024)
    throw new Error("提交内容超过 1 MB 限制");
  return { ...input, serverUrl: origin, url: url.href };
}

export function validatePaperclipDownload(serverUrl: unknown, path: unknown): string {
  const origin = canonicalPaperclipOrigin(serverUrl);
  if (
    typeof path !== "string" ||
    !new RegExp(`^/api/(attachments|assets)/${id}/content(?:\\?download=1)?$`).test(path)
  ) {
    throw new Error("仅支持下载当前服务器的附件和资源");
  }
  return new URL(path, origin).href;
}

export function safeDownloadFilename(value: unknown): string {
  if (typeof value !== "string") return "Paperclip-产物";
  // 控制字符不能作为产物文件名；此处有意清除，避免平台文件对话框歧义。
  const name = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\x00-\x1f:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return name || "Paperclip-产物";
}

export function publicPaperclipSession(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const candidate = root.user ? root : root.data;
  if (!candidate || typeof candidate !== "object") return null;
  const data = candidate as Record<string, unknown>;
  const user = data.user as Record<string, unknown> | undefined;
  const session = data.session as Record<string, unknown> | undefined;
  if (!user || typeof user.id !== "string") return null;
  return {
    user: {
      id: user.id,
      name: typeof user.name === "string" ? user.name : null,
      email: typeof user.email === "string" ? user.email : null,
    },
    session: { expiresAt: session?.expiresAt ?? null },
  };
}

export function matchesPaperclipRenderer(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}
