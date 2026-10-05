import {
  PAPERCLIP_CREATE_RETRY_WINDOW_DAYS,
  type PaperclipPreferences,
  type PaperclipStoredReceipt,
} from "@zcode/shared";
import type { PaperclipReceipt, PaperclipMutationCommand } from "../contract.js";
import { creationRetryPermitted } from "../domain/identity.js";

/**
 * 发送前准入（无 IO）：返回的拒绝都发生在任何网络请求之前，调用方据此发布 rejected 回执。
 * 未知回执阻止同身份的新写入，只有沿用原请求编号的手动重试可以通过；创建重试受客户端窗口限制。
 */
export function preSendRefusal(
  busy: boolean,
  receipts: Record<string, PaperclipReceipt>,
  command: PaperclipMutationCommand,
  previous: PaperclipReceipt | undefined,
): { message: string; reason: "busy" | "unknown-pending" | "retry-window" } | null {
  if (busy) return { message: "正在同步，请稍后重试。", reason: "busy" };
  const retryingUnknown =
    previous?.state === "unknown" &&
    previous.kind === command.kind &&
    "retry" in command &&
    command.retry &&
    (command.kind === "create" || previous.targetId === command.issueId);
  if (Object.values(receipts).some((row) => row.state === "unknown") && !retryingUnknown)
    return { message: "原提交结果未知，需核对后手动重试。", reason: "unknown-pending" };
  if (
    command.kind === "create" &&
    !creationRetryPermitted(previous?.submittedAt ?? command.firstSubmittedAt)
  )
    return {
      message: `创建提交已超出 ${PAPERCLIP_CREATE_RETRY_WINDOW_DAYS} 天重试窗口或缺少可信时间，请先核对任务列表。草稿已保留。`,
      reason: "retry-window",
    };
  return null;
}

export function pendingReceipt(
  command: PaperclipMutationCommand,
  identity: string,
  id: string,
  previousSubmittedAt?: number,
): PaperclipStoredReceipt {
  return {
    id,
    identity,
    kind: command.kind,
    state: "unknown",
    submittedAt:
      previousSubmittedAt ?? (command.kind === "create" ? command.firstSubmittedAt : Date.now()),
    targetId: command.kind === "create" ? undefined : command.issueId,
    ...(command.kind === "status"
      ? { status: command.status, unblockAction: command.unblockAction }
      : {}),
    ...(command.kind === "approval"
      ? {
          operationTargetId: command.approvalId,
          expectedStatus: command.approve ? "approved" : "rejected",
        }
      : {}),
    ...(command.kind === "cancel" ? { operationTargetId: command.runId } : {}),
  };
}

/** 持久化只保存人工核对所需元数据；服务端正文、Cookie 和投影不进入 settings。 */
export function receiptsFor(
  preferences: PaperclipPreferences,
  identity: string,
): Record<string, PaperclipReceipt> {
  return Object.fromEntries(
    (preferences.receipts ?? [])
      .filter((row) => row.identity === identity)
      .map((row) => [row.id, row]),
  );
}
export function updateReceipt(
  preferences: PaperclipPreferences,
  identity: string,
  id: string,
  receipt?: PaperclipStoredReceipt,
): PaperclipPreferences {
  const rows = (preferences.receipts ?? []).filter(
    (row) => row.identity !== identity || row.id !== id,
  );
  if (receipt) rows.push(receipt);
  const pending = rows.filter((row) => row.state === "unknown");
  if (pending.length > 100) throw new Error("待核对操作过多，已阻止新提交，请先人工核对。");
  const archived = rows.filter((row) => row.state === "archived").slice(-(100 - pending.length));
  return { ...preferences, receipts: [...pending, ...(pending.length === 100 ? [] : archived)] };
}
