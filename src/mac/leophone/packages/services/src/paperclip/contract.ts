export { creationRetryPermitted, paperclipIdentityKey } from "./domain/identity.js";
export interface PaperclipUser {
  id: string;
  name?: string | null;
  email?: string | null;
}
export interface PaperclipCompany {
  id: string;
  name: string;
}
export interface PaperclipAgent {
  id: string;
  companyId: string;
  name: string;
  status: string;
}
export interface PaperclipIssue {
  id: string;
  companyId: string;
  title: string;
  description?: string | null;
  identifier?: string | null;
  status: string;
  priority: string;
  assigneeAgentId?: string | null;
  unblockDescriptor?: { owner: unknown; action: string } | null;
}
export interface PaperclipComment {
  id: string;
  companyId: string;
  issueId: string;
  body: string;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  createdAt?: string | null;
  clientRequestId?: string | null;
}
export interface PaperclipRun {
  runId: string;
  agentId: string;
  status: string;
}
export interface PaperclipApproval {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decisionNote?: string | null;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
}
export interface PaperclipAttachment {
  id: string;
  assetId: string;
  companyId: string;
  issueId: string;
  originalFilename?: string | null;
  contentPath: string;
  byteSize: number;
}
export interface PaperclipDetail {
  issue: PaperclipIssue;
  comments: PaperclipComment[];
  runs: PaperclipRun[];
  approvals: PaperclipApproval[];
  attachments: PaperclipAttachment[];
}
export interface PaperclipReceipt {
  id: string;
  state: "confirmed" | "unknown" | "rejected" | "archived";
  message?: string;
  kind?: PaperclipMutationCommand["kind"];
  submittedAt?: number;
  targetId?: string;
  status?: string;
  unblockAction?: string;
  operationTargetId?: string;
  expectedStatus?: string;
}
export interface PaperclipSnapshot {
  generation: number;
  origin: string;
  user: PaperclipUser | null;
  companyId: string;
  companies: PaperclipCompany[];
  agents: PaperclipAgent[];
  issues: PaperclipIssue[];
  hasMore: boolean;
  detail: PaperclipDetail | null;
  selectedIssueId: string | null;
  busy: boolean;
  error: string | null;
  ready?: boolean;
  log: { runId: string; content: string; nextOffset: number } | null;
  receipts: Record<string, PaperclipReceipt>;
  confirmedReply?: { receiptId: string; identity: string; issueId: string; body: string } | null;
}
export type PaperclipCommand =
  | PaperclipMutationCommand
  | { kind: "archive"; receiptId: string }
  | { kind: "reconcile"; receiptId: string };
export type PaperclipMutationCommand =
  | {
      kind: "create";
      requestId: string;
      firstSubmittedAt: number;
      retry: boolean;
      title: string;
      description: string;
      agentId?: string;
    }
  | { kind: "comment"; requestId: string; retry: boolean; issueId: string; body: string }
  | { kind: "status"; issueId: string; status: string; unblockAction?: string }
  | {
      kind: "approval";
      issueId: string;
      approvalId: string;
      approve: boolean;
      note: string;
      expectedApproval: string;
    }
  | { kind: "cancel"; issueId: string; runId: string };
export interface IPaperclipWorkspace {
  getSnapshot(): PaperclipSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<void>;
  configure(origin: string): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  selectCompany(companyId: string): Promise<void>;
  refresh(loadMore?: boolean): Promise<void>;
  selectIssue(issueId: string): Promise<void>;
  command(command: PaperclipCommand): Promise<void>;
  readLog(runId: string): Promise<void>;
  downloadAttachment(attachmentId: string): Promise<void>;
}
