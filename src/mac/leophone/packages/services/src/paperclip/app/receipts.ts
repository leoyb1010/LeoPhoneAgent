import type { PaperclipPreferences, PaperclipStoredReceipt } from "@zcode/shared";
import type { PaperclipReceipt, PaperclipMutationCommand } from "../contract.js";

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
