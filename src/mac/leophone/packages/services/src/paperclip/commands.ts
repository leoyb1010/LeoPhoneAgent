import { PaperclipFailure, paperclipApprovalFingerprint } from "./protocol.js";
import type { PaperclipCommand, PaperclipSnapshot } from "./contract.js";
export function validatePaperclipCommand(state: PaperclipSnapshot, c: PaperclipCommand) {
  const detail = state.detail;
  if (c.kind === "create") {
    if (
      !c.title.trim() ||
      !state.agents.some(
        (a) => a.id === c.agentId && !["paused", "terminated", "error"].includes(a.status),
      )
    )
      throw new Error("请填写任务标题并选择可用的服务器执行者");
    return;
  }
  if (!detail || detail.issue.id !== c.issueId) throw new Error("任务已切换，请重新打开任务后操作");
  if (c.kind === "reply" && !c.body.trim()) throw new Error("请输入回复内容");
  if (
    c.kind === "status" &&
    !["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(
      c.status,
    )
  )
    throw new Error("请选择有效任务状态");
  if (
    c.kind === "cancel" &&
    !detail.runs.some((r) => r.id === c.runId && ["queued", "running"].includes(r.status))
  )
    throw new Error("此运行已经结束或不属于当前任务");
  if (
    (c.kind === "approve" || c.kind === "reject") &&
    !detail.approvals.some(
      (a) =>
        a.id === c.approvalId &&
        a.status === "pending" &&
        paperclipApprovalFingerprint(a) === c.expectedApproval,
    )
  )
    throw new Error("审批已处理或不属于当前任务，请刷新");
}

export const emptyPaperclipSnapshot = (): PaperclipSnapshot => ({
  profile: null,
  user: null,
  companies: [],
  binding: null,
  agents: [],
  issues: [],
  detail: null,
  connection: "unconfigured",
  busy: false,
  error: null,
  notice: null,
  receipt: null,
  log: null,
  updatedAt: null,
});

export function paperclipFailureState(error: unknown): Partial<PaperclipSnapshot> {
  const auth = error instanceof PaperclipFailure && error.status === 401;
  return {
    error: error instanceof Error ? error.message : "操作未完成，请重试",
    ...(auth ? { connection: "signed-out" as const } : {}),
  };
}
