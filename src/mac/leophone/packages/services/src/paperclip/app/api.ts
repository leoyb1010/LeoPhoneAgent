import { healthSchema } from "./responses.js";
import type { NativePaperclipPort } from "@zcode/shared";
import { createServiceLogger } from "../../logger/serviceLogger.js";

// 工作台服务运行在 renderer：关闭依赖 Node 环境变量的 debug 判定。
// 日志只记录事件、方法与错误类型，不含服务器地址、邮箱、正文、Cookie 或 token。
export const paperclipLog = createServiceLogger("paperclip", { isDebugEnabled: false });
export class OperationError extends Error {
  constructor(
    message: string,
    readonly kind: "unknown" | "rejected" | "signed-out" | "unready" = "rejected",
  ) {
    super(message);
  }
}

export async function requestPaperclip(
  port: NativePaperclipPort,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body: unknown,
  userId: string | undefined,
  origin: string,
): Promise<unknown> {
  let reply: { status: number; data: unknown };
  try {
    reply = await port.request({
      serverUrl: origin,
      path,
      method,
      body,
      expectedUserId: path === "/api/health" ? undefined : userId,
    });
  } catch (error) {
    paperclipLog.error(
      undefined,
      `原生传输异常 method=${method} error=${error instanceof Error ? error.name : typeof error}`,
    );
    throw new OperationError(
      method === "GET"
        ? "无法连接服务器，请检查网络后刷新。"
        : "提交结果待确认，请先刷新核对。不会自动重发或转为本机执行。",
      method === "GET" ? "rejected" : "unknown",
    );
  }
  if (reply.status === 401) throw new OperationError("登录已过期，请重新登录。", "signed-out");
  if (reply.status === 403) throw new OperationError("当前用户没有执行此操作的权限。");
  if (reply.status < 200 || reply.status >= 300) {
    const unknown = method !== "GET" && reply.status >= 500;
    throw new OperationError(
      unknown
        ? "提交结果待确认，请刷新核对后决定。"
        : `服务器请求失败（HTTP ${reply.status}），请刷新后核对。`,
      unknown ? "unknown" : "rejected",
    );
  }
  return reply.data;
}

export function assertPaperclipReady(raw: unknown): void {
  if (!healthSchema.safeParse(raw).success)
    throw new OperationError("服务器尚未就绪或未启用安全登录，请稍后刷新或联系管理员。", "unready");
}
