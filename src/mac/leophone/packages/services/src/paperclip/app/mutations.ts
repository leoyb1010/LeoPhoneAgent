import type { PaperclipCommand } from "../contract.js";
import { paperclipId } from "../domain/identity.js";
import { approvalSchema, cancelledRunSchema, commentSchema, issueSchema } from "./responses.js";

export function buildPaperclipMutation(
  command: PaperclipCommand,
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
  command: PaperclipCommand,
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
