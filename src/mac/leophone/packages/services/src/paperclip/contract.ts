/** Paperclip 固定版本适配器；运行实现仅通过注入的原生传输访问网络。 */
export { PaperclipWorkspaceService } from "./workspace.js";
export {
  canonicalPaperclipServer,
  paperclipLabel,
  paperclipError,
  paperclipApprovalFingerprint,
} from "./protocol.js";
export type PaperclipMethod = "GET" | "POST" | "PATCH";
export interface PaperclipTransport {
  request(input: {
    serverUrl: string;
    method: PaperclipMethod;
    path: string;
    body?: unknown;
    expectedUserId?: string;
  }): Promise<{ status: number; data: unknown }>;
  signIn(input: { serverUrl: string }): Promise<{ completed: boolean }>;
  signOut(input: { serverUrl: string }): Promise<void>;
  download?(input: { serverUrl: string; path: string; filename: string }): Promise<void>;
}
export interface PaperclipPersistence {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface PaperclipProfile {
  serverUrl: string;
  name: string;
}
export interface PaperclipBinding {
  serverUrl: string;
  companyId: string;
  userId: string;
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
  adapterType?: string;
}
export interface PaperclipIssue {
  id: string;
  companyId: string;
  identifier?: string;
  title: string;
  description?: string | null;
  status: string;
  assigneeAgentId?: string | null;
  updatedAt?: string;
}
export interface PaperclipComment {
  id: string;
  issueId: string;
  companyId: string;
  body: string;
  clientRequestId?: string | null;
  createdAt?: string;
  authorUserId?: string | null;
  authorAgentId?: string | null;
}
export interface PaperclipRun {
  id: string;
  agentId: string;
  status: string;
  agentName?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
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
export interface PaperclipDocument {
  id: string;
  issueId: string;
  companyId: string;
  key: string;
  title?: string | null;
  body?: string;
}
export interface PaperclipAttachment {
  id: string;
  issueId: string;
  companyId: string;
  originalFilename?: string | null;
  contentType?: string;
  byteSize?: number;
  contentPath?: string;
}
export interface PaperclipWorkProduct {
  id: string;
  issueId: string;
  companyId: string;
  title: string;
  type: string;
  status: string;
  url?: string | null;
  summary?: string | null;
}
export interface PaperclipDetail {
  issue: PaperclipIssue;
  comments: PaperclipComment[];
  runs: PaperclipRun[];
  approvals: PaperclipApproval[];
  documents: PaperclipDocument[];
  attachments: PaperclipAttachment[];
  products: PaperclipWorkProduct[];
}
export type PaperclipCommand =
  | { kind: "create"; title: string; description: string; agentId: string }
  | { kind: "reply"; issueId: string; body: string }
  | { kind: "status"; issueId: string; status: string }
  | {
      kind: "approve" | "reject";
      issueId: string;
      approvalId: string;
      expectedApproval: string;
      decisionNote: string;
    }
  | { kind: "cancel"; issueId: string; runId: string };
export interface PaperclipReceipt {
  id: string;
  binding: PaperclipBinding;
  command: PaperclipCommand;
  createdAt: string;
  state: "sending" | "uncertain" | "acknowledged";
}
export interface PaperclipSnapshot {
  profile: PaperclipProfile | null;
  user: { id: string; name: string } | null;
  companies: PaperclipCompany[];
  binding: PaperclipBinding | null;
  agents: PaperclipAgent[];
  issues: PaperclipIssue[];
  detail: PaperclipDetail | null;
  connection: "unconfigured" | "signed-out" | "connecting" | "online" | "offline";
  busy: boolean;
  error: string | null;
  notice: string | null;
  receipt: PaperclipReceipt | null;
  log: { runId: string; content: string; nextOffset: number } | null;
  updatedAt: string | null;
}
