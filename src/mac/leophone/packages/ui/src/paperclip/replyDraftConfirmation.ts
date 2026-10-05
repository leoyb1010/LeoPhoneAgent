import type { PaperclipSnapshot } from "@zcode/services";
type ReplyConfirmation = NonNullable<PaperclipSnapshot["confirmedReply"]>;
interface SubmittedPaperclipReply {
  body: string;
  draft: string;
  receiptId?: string;
  identity?: string;
}
export function matchesPaperclipReplyConfirmation(
  pending: SubmittedPaperclipReply | null,
  confirmed: ReplyConfirmation | null,
  issueId: string,
): boolean {
  return (
    !!pending &&
    !!confirmed &&
    !!pending.receiptId &&
    !!pending.identity &&
    pending.receiptId === confirmed.receiptId &&
    confirmed.issueId === issueId &&
    pending.body === confirmed.body &&
    pending.identity === confirmed.identity
  );
}
export function clearConfirmedPaperclipDraft(
  draft: string,
  pending: SubmittedPaperclipReply | null,
  confirmed: ReplyConfirmation | null,
  issueId: string,
): string {
  return matchesPaperclipReplyConfirmation(pending, confirmed, issueId) && draft === pending?.draft
    ? ""
    : draft;
}
