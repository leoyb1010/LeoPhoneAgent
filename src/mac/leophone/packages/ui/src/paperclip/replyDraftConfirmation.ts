import type { PaperclipBinding, PaperclipReplyConfirmation } from "@zcode/services/paperclip";
export interface SubmittedPaperclipReply {
  body: string;
  draft: string;
  receiptId?: string;
  binding?: PaperclipBinding;
}
export function matchesPaperclipReplyConfirmation(
  pending: SubmittedPaperclipReply | null,
  confirmed: PaperclipReplyConfirmation | null,
  issueId: string,
): boolean {
  return (
    !!pending &&
    !!confirmed &&
    !!pending.receiptId &&
    !!pending.binding &&
    pending.receiptId === confirmed.receiptId &&
    confirmed.issueId === issueId &&
    pending.body === confirmed.body &&
    pending.binding.serverUrl === confirmed.binding.serverUrl &&
    pending.binding.companyId === confirmed.binding.companyId &&
    pending.binding.userId === confirmed.binding.userId
  );
}
export function clearConfirmedPaperclipDraft(
  draft: string,
  pending: SubmittedPaperclipReply | null,
  confirmed: PaperclipReplyConfirmation | null,
  issueId: string,
): string {
  return matchesPaperclipReplyConfirmation(pending, confirmed, issueId) && draft === pending?.draft
    ? ""
    : draft;
}
