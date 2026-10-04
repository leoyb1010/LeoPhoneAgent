/** LeoPhoneAgent Chinese UI display layer. Protocol values remain unchanged. */
export const STATUS_ZH: Readonly<Record<string, string>> = {
  backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "待审核",
  done: "已完成", blocked: "受阻", cancelled: "已取消", active: "活跃", idle: "空闲",
  running: "运行中", paused: "已暂停", error: "异常", pending_approval: "待批准",
  terminated: "已终止", pending: "待处理", approved: "已批准", rejected: "已拒绝",
  revision_requested: "要求修改", resubmitted: "已重新提交", succeeded: "已成功",
  failed: "已失败", timed_out: "已超时", queued: "排队中", draft: "草稿",
  planned: "已规划", achieved: "已达成", archived: "已归档", cancelled_by_user: "用户已取消",
  critical: "紧急", high: "高", medium: "中", low: "低", open: "打开", closed: "已关闭",
  healthy: "正常", warning: "预警", hard_stop: "强制停止", disabled: "已禁用",
};
export function displayStatus(value: string): string { return STATUS_ZH[value] ?? value; }

const AUTH_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确，请检查后重试。",
  USER_NOT_FOUND: "邮箱或密码不正确，请检查后重试。",
  INVALID_PASSWORD: "邮箱或密码不正确，请检查后重试。",
  USER_ALREADY_EXISTS: "此邮箱已注册，请直接登录或联系管理员。",
  PASSWORD_TOO_SHORT: "密码过短，请至少输入 8 个字符。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  SIGNUP_DISABLED: "此实例已关闭自行注册，请联系管理员获取邀请。",
  EMAIL_NOT_VERIFIED: "请先验证邮箱，再尝试登录。",
};
const EXACT_ERRORS: Readonly<Record<string, string>> = {
  "Invalid email or password": AUTH_MESSAGES.INVALID_EMAIL_OR_PASSWORD,
  "Invalid password": AUTH_MESSAGES.INVALID_PASSWORD,
  "User already exists": AUTH_MESSAGES.USER_ALREADY_EXISTS,
  "User already exists. Use another email.": AUTH_MESSAGES.USER_ALREADY_EXISTS,
  "Failed to fetch": "无法连接服务器，请检查网络连接和服务器地址。",
  "Load failed": "无法连接服务器，请检查网络连接和服务器地址。",
  "NetworkError when attempting to fetch resource.": "无法连接服务器，请检查网络连接和服务器地址。",
  "Document is locked": "文档正在被其他操作锁定，请稍后重试。",
};
export function rawDiagnostic(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "";
}
export function userErrorMessage(error: unknown): string {
  const raw = rawDiagnostic(error);
  if (/[\u3400-\u9fff]/.test(raw)) return raw;
  if (EXACT_ERRORS[raw]) return EXACT_ERRORS[raw];
  const fields = error && typeof error === "object" ? error as { code?: string; status?: number; name?: string } : {};
  if (fields.code && AUTH_MESSAGES[fields.code]) return AUTH_MESSAGES[fields.code];
  if (fields.name === "AbortError") return "操作已取消。";
  const statuses: Readonly<Record<number, string>> = {
    400: "请求内容有误，请检查表单后重试。", 401: "登录已过期或身份验证失败，请重新登录。",
    403: "当前账号没有执行此操作的权限，请联系管理员。", 404: "未找到请求的内容，可能已被删除或移动。",
    409: "此操作与当前状态冲突，请刷新后重试。", 413: "上传内容超过大小限制，请缩小文件后重试。",
    422: "输入内容未通过校验，请检查必填项和格式。", 429: "请求过于频繁，请稍后重试。",
    500: "服务器处理失败，请稍后重试或联系管理员。", 502: "服务暂时不可用，请稍后重试。",
    503: "服务暂时不可用，请稍后重试。", 504: "服务器响应超时，请稍后重试。",
  };
  return statuses[fields.status ?? 0] ?? "操作未完成，请重试；如仍失败，请查看原始诊断并联系管理员。";
}
