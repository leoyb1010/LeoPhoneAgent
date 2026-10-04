import { useEffect, useRef, useState } from "react";
import type { PaperclipReceipt, PaperclipReplyConfirmation } from "@zcode/services/paperclip";
import {
  clearConfirmedPaperclipDraft,
  matchesPaperclipReplyConfirmation,
  type SubmittedPaperclipReply,
} from "../paperclip/replyDraftConfirmation.js";

/** 草稿是本地编辑状态；只有当前编辑器提交的精确回执确认才能清空它。 */
export function usePaperclipReplyDraft(
  issueId: string,
  receipt: PaperclipReceipt | null,
  confirmed: PaperclipReplyConfirmation | null,
) {
  const [reply, setReply] = useState("");
  const submitted = useRef<SubmittedPaperclipReply | null>(null);
  const markSubmitted = (body: string) => {
    submitted.current = { body, draft: reply };
  };
  useEffect(() => {
    const pending = submitted.current;
    if (
      pending &&
      receipt?.command.kind === "reply" &&
      receipt.command.issueId === issueId &&
      receipt.command.body === pending.body &&
      !pending.receiptId
    ) {
      pending.receiptId = receipt.id;
      pending.binding = receipt.binding;
    }
  }, [receipt, issueId]);
  useEffect(() => {
    const pending = submitted.current;
    if (!matchesPaperclipReplyConfirmation(pending, confirmed, issueId)) return;
    setReply((current) => clearConfirmedPaperclipDraft(current, pending, confirmed, issueId));
    submitted.current = null;
  }, [confirmed, issueId]);
  return { reply, setReply, markSubmitted };
}
