/** UI receipts only, not authorization grants. Never store raw arguments, tickets or credentials. */
export class ApprovalReceipt {
  sessionId: string = '';
  at: number = 0;
  decision: string = '';
}
export class ChatInteractionStore {
  private static receipts: ApprovalReceipt[] = [];
  static record(sessionId: string, decision: string): void {
    const receipt = new ApprovalReceipt(); receipt.sessionId = sessionId;
    receipt.decision = decision; receipt.at = Date.now();
    ChatInteractionStore.receipts = ChatInteractionStore.receipts.concat([receipt]).slice(-200);
    AppStorage.setOrCreate('interactionTick', Date.now());
  }
  static forSession(id: string): ApprovalReceipt[] { return ChatInteractionStore.receipts.filter((row: ApprovalReceipt) => row.sessionId === id); }
}
