import type { PaperclipBinding, PaperclipMethod, PaperclipTransport } from "./contract.js";

export class PaperclipFailure extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? paperclipError(status));
  }
}
export function paperclipError(status: number): string {
  if (status === 401) return "登录已过期，请重新登录服务器";
  if (status === 403) return "当前账号没有此操作的权限，请联系服务器管理员";
  if (status === 404) return "内容不存在或已移除，请刷新后重试";
  if (status === 409) return "服务器状态已变化，请刷新后核对";
  if (status === 422 || status === 400) return "服务器未接受填写的内容，请检查任务、执行者和状态";
  if (status === 429) return "请求过于频繁，请稍后刷新";
  if (status >= 500) return "服务器暂时异常；已提交的操作需要核实结果";
  if (status === 0) return "无法连接服务器，请检查网络、服务器地址和证书";
  return "服务器返回的数据无法识别，请检查服务器版本";
}
export function canonicalPaperclipServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整服务器地址，例如 https://paperclip.example.com");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("服务器地址必须是 HTTPS 源地址，不能包含路径、账号或参数；本机调试才允许 HTTP");
  }
  return url.origin;
}
export const bindingKey = (binding: PaperclipBinding) =>
  JSON.stringify([binding.serverUrl, binding.companyId, binding.userId]);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaperclipFailure(-1);
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PaperclipFailure(-1);
  return value;
}
export function rows<T>(
  value: unknown,
  required: string[],
  binding?: PaperclipBinding,
  issueId?: string,
): T[] {
  if (!Array.isArray(value)) throw new PaperclipFailure(-1);
  return value.map((entry) => {
    const row = object(entry);
    for (const field of required) {
      if (field === "body") {
        if (typeof row[field] !== "string") throw new PaperclipFailure(-1);
      } else string(row[field]);
    }
    if (binding && row.companyId !== binding.companyId)
      throw new PaperclipFailure(-1, "服务器返回了其他公司的内容，已阻止显示");
    if (issueId && row.issueId !== issueId)
      throw new PaperclipFailure(-1, "服务器返回了其他任务的内容，已阻止显示");
    return row as T;
  });
}
export async function request(
  transport: PaperclipTransport,
  serverUrl: string,
  method: PaperclipMethod,
  path: string,
  body?: unknown,
  expectedUserId?: string,
): Promise<unknown> {
  let response: { status: number; data: unknown };
  try {
    response = await transport.request({
      serverUrl,
      method,
      path: `/api${path}`,
      ...(body === undefined ? {} : { body }),
      ...(expectedUserId ? { expectedUserId } : {}),
    });
  } catch {
    throw new PaperclipFailure(0);
  }
  if (response.status < 200 || response.status >= 300) throw new PaperclipFailure(response.status);
  return response.data;
}
export async function session(
  transport: PaperclipTransport,
  serverUrl: string,
): Promise<{ id: string; name: string }> {
  const raw = await request(transport, serverUrl, "GET", "/auth/get-session");
  if (!raw) throw new PaperclipFailure(401);
  const outer = object(raw);
  const envelope = outer.user ? outer : object(outer.data);
  const user = object(envelope.user);
  return { id: string(user.id), name: typeof user.name === "string" ? user.name : "已登录用户" };
}
const labels: Record<string, string> = {
  backlog: "待安排",
  todo: "待执行",
  in_progress: "进行中",
  in_review: "待审阅",
  done: "已完成",
  blocked: "受阻",
  cancelled: "已取消",
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  timed_out: "已超时",
  idle: "空闲",
  active: "可用",
  paused: "已暂停",
  error: "异常",
  terminated: "已停用",
  pending: "待审批",
  pending_approval: "等待批准",
  scheduled_retry: "等待重试",
  interrupted: "已中断",
  budget_override_required: "预算超限审批",
  request_board_approval: "人工审批请求",
  approved: "已批准",
  rejected: "已拒绝",
  revision_requested: "要求修改",
  hire_agent: "新增执行者",
  approve_ceo_strategy: "战略审批",
  ready_for_review: "待审阅",
  changes_requested: "需要修改",
  merged: "已合并",
  closed: "已关闭",
  archived: "已归档",
  draft: "草稿",
  preview_url: "预览页面",
  runtime_service: "运行服务",
  pull_request: "合并请求",
  branch: "分支",
  commit: "代码提交",
  artifact: "文件成果",
  document: "文档",
};
export const paperclipLabel = (value: string) => labels[value] ?? "其他状态";

/** 稳定序列化用户看到的审批快照，避免对象属性顺序导致误报。 */
export function paperclipApprovalFingerprint(value: unknown): string {
  const row = object(value);
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : value;
  return JSON.stringify(
    normalize({
      id: row.id,
      companyId: row.companyId,
      type: row.type,
      status: row.status,
      payload: row.payload,
      requestedByAgentId: row.requestedByAgentId ?? null,
      requestedByUserId: row.requestedByUserId ?? null,
    }),
  );
}

export async function verifyPaperclipUser(
  transport: PaperclipTransport,
  binding: PaperclipBinding,
): Promise<void> {
  const user = await session(transport, binding.serverUrl);
  if (user.id !== binding.userId)
    throw new PaperclipFailure(401, "登录账号已变化。请重新连接公司，原账号待核实操作会保留");
}
