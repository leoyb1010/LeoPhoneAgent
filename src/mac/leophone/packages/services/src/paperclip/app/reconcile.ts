import type { PaperclipMutationCommand } from "../contract.js";
import { PAPERCLIP_ISSUE_STATUSES, type PaperclipStoredReceipt } from "@zcode/shared";
import { paperclipId } from "../domain/identity.js";
import { issueSchema } from "./responses.js";
export function normalizeStatusCommand(
  command: PaperclipMutationCommand,
): PaperclipMutationCommand {
  if (command.kind !== "status") return command;
  if (!(PAPERCLIP_ISSUE_STATUSES as readonly string[]).includes(command.status))
    throw new Error("请选择有效任务状态。");
  if (command.status !== "blocked") return { ...command, unblockAction: undefined };
  const action = command.unblockAction?.trim();
  if (!action || action.length > 2000)
    throw new Error("请填写解除受阻所需操作（1 到 2000 个字符）。");
  return { ...command, unblockAction: action };
}
export function statusMatches(
  issue: { status: string; unblockDescriptor?: { owner: unknown; action: string } | null },
  status: string,
  action: string | undefined,
  userId: string,
): boolean {
  if (issue.status !== status) return false;
  if (status !== "blocked") return true;
  const owner = issue.unblockDescriptor?.owner;
  return (
    !!owner &&
    typeof owner === "object" &&
    !Array.isArray(owner) &&
    Object.keys(owner).length === 1 &&
    (owner as { userId?: unknown }).userId === userId &&
    issue.unblockDescriptor?.action === action
  );
}
export async function readReconciliation(
  api: (path: string) => Promise<unknown>,
  receipt: PaperclipStoredReceipt,
  userId: string,
  companyId: string,
): Promise<void> {
  if (!receipt.targetId) throw new Error("缺少原操作绑定信息，请人工核对。");
  if (receipt.kind === "create" || receipt.kind === "comment")
    throw new Error("创建和回复请使用保留原请求编号的草稿重试。");
  const target = receipt.kind === "status" ? receipt.targetId : receipt.operationTargetId;
  if (!target) throw new Error("旧回执缺少原操作目标，请人工核对。");
  const path =
    receipt.kind === "status"
      ? `/api/issues/${paperclipId(target)}`
      : receipt.kind === "cancel"
        ? `/api/heartbeat-runs/${paperclipId(target)}`
        : `/api/approvals/${paperclipId(target)}`;
  const raw = await api(path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("服务器结果尚未核实。");
  const row = raw as { id?: unknown; companyId?: unknown; status?: unknown };
  if (row.id !== target || row.companyId !== companyId) throw new Error("服务器回执归属不匹配。");
  const match =
    receipt.kind === "status"
      ? !!receipt.status &&
        statusMatches(issueSchema.parse(raw), receipt.status, receipt.unblockAction, userId)
      : receipt.kind === "cancel"
        ? ["cancelled", "succeeded", "failed", "timed_out"].includes(String(row.status))
        : row.status === receipt.expectedStatus;
  if (!match) throw new Error("服务器尚未确认原操作。可以继续核实，不会再次发送。");
}
