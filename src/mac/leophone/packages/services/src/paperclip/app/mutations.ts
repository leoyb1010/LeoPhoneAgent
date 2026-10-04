import type { PaperclipMutationCommand, PaperclipDetail } from "../contract.js";
import { paperclipApprovalFingerprint } from "../domain/approval.js";
import { paperclipId } from "../domain/identity.js";
import { approvalSchema, cancelledRunSchema, commentSchema, issueSchema } from "./responses.js";

export function verifyPaperclipCommandRelation(
  command: PaperclipMutationCommand,
  detail: PaperclipDetail,
): void {
  if (
    command.kind === "approval" &&
    !detail.approvals.some(
      (row) =>
        row.id === command.approvalId &&
        row.status === "pending" &&
        paperclipApprovalFingerprint(row) === command.expectedApproval,
    )
  )
    throw new Error("审批内容或申请者已改变，请刷新后重新核对完整请求。");
  if (
    command.kind === "cancel" &&
    !detail.runs.some(
      (row) => row.runId === command.runId && ["running", "queued"].includes(row.status),
    )
  )
    throw new Error("此任务运行已结束或不属于当前任务。");
}

export async function verifyLatestApproval(
  api: (path: string) => Promise<unknown>,
  command: Extract<PaperclipMutationCommand, { kind: "approval" }>,
): Promise<void> {
  const latest = approvalSchema.parse(
    await api(`/api/approvals/${paperclipId(command.approvalId)}`),
  );
  if (paperclipApprovalFingerprint(latest) !== command.expectedApproval)
    throw new Error("审批内容或申请者已改变，请重新核对完整请求。");
}

export function buildPaperclipMutation(
  command: PaperclipMutationCommand,
  companyId: string,
  requestId: string,
) {
  const path =
    command.kind === "create"
      ? `/api/companies/${paperclipId(companyId)}/issues`
      : command.kind === "approval"
        ? `/api/approvals/${paperclipId(command.approvalId)}/${command.approve ? "approve" : "reject"}`
        : command.kind === "cancel"
          ? `/api/heartbeat-runs/${paperclipId(command.runId)}/cancel`
          : `/api/issues/${paperclipId(command.issueId)}${command.kind === "comment" ? "/comments" : ""}`;
  const body =
    command.kind === "create"
      ? {
          title: command.title,
          description: command.description,
          priority: "medium",
          status: command.agentId ? "todo" : "backlog",
          assigneeAgentId: command.agentId,
          idempotencyKey: requestId,
        }
      : command.kind === "comment"
        ? { body: command.body, clientRequestId: requestId }
        : command.kind === "status"
          ? { status: command.status }
          : command.kind === "approval"
            ? { decisionNote: command.note }
            : {};
  return { path, body, method: command.kind === "status" ? ("PATCH" as const) : ("POST" as const) };
}

/** 无 IO 的回执校验；返回创建后的任务 ID，其余命令仍由同一协调者发布读取投影。 */
export function verifyPaperclipMutation(
  command: PaperclipMutationCommand,
  raw: unknown,
  companyId: string,
  requestId: string,
): string | undefined {
  if (command.kind === "create" || command.kind === "status") {
    const issue = issueSchema.parse(raw);
    if (
      issue.companyId !== companyId ||
      (command.kind === "status" &&
        (issue.id !== command.issueId || issue.status !== command.status))
    )
      throw new Error("服务器回执归属不兼容。");
    if (command.kind === "create") return issue.id;
  } else if (command.kind === "comment") {
    const comment = commentSchema.parse(raw);
    if (
      comment.companyId !== companyId ||
      comment.issueId !== command.issueId ||
      comment.clientRequestId !== requestId
    )
      throw new Error("回复回执不兼容。");
  } else if (command.kind === "approval") {
    const approval = approvalSchema.parse(raw);
    if (
      approval.id !== command.approvalId ||
      approval.companyId !== companyId ||
      approval.status !== (command.approve ? "approved" : "rejected")
    )
      throw new Error("审批结果待核对。");
  } else if (cancelledRunSchema.parse(raw).id !== command.runId)
    throw new Error("运行取消结果待核对。");
  return undefined;
}
