import { z } from "zod";
import type { PaperclipSnapshot } from "../contract.js";

const id = z.string().min(1);
export const userSchema = z.object({
  id,
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});
export const companySchema = z.object({ id, name: z.string() });
export const agentSchema = z.object({ id, companyId: id, name: z.string(), status: z.string() });
export const issueSchema = z.object({
  id,
  companyId: id,
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  description: z.string().nullable().optional(),
  identifier: z.string().nullable().optional(),
  assigneeAgentId: z.string().nullable().optional(),
  unblockDescriptor: z.object({ owner: z.unknown(), action: z.string() }).nullable().optional(),
});
export const commentSchema = z.object({
  id,
  companyId: id,
  issueId: id,
  body: z.string(),
  authorUserId: z.string().nullable().optional(),
  authorAgentId: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  clientRequestId: z.string().nullable().optional(),
});
export const runSchema = z.object({ runId: id, agentId: id, status: z.string() });
export const approvalSchema = z.object({
  id,
  companyId: id,
  type: z.string(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()),
  decisionNote: z.string().nullable().optional(),
  requestedByAgentId: z.string().nullable().optional(),
  requestedByUserId: z.string().nullable().optional(),
});
export const attachmentSchema = z.object({
  id,
  assetId: id,
  companyId: id,
  issueId: id,
  contentPath: z.string(),
  byteSize: z.number(),
  originalFilename: z.string().nullable().optional(),
});
export const healthSchema = z.object({
  status: z.literal("ok"),
  deploymentMode: z.literal("authenticated"),
  authReady: z
    .boolean()
    .optional()
    .refine((value) => value !== false, "服务器身份认证尚未就绪，请等待管理员完成初始化。"),
});
export const sessionSchema = z.object({ user: userSchema });
export const logSchema = z.object({
  runId: id,
  content: z.string(),
  nextOffset: z.number().int().nonnegative().safe(),
});
export const cancelledRunSchema = z.object({ id, status: z.literal("cancelled") });

export const emptyPaperclipSnapshot = (): PaperclipSnapshot => ({
  generation: 0,
  origin: "",
  user: null,
  companyId: "",
  companies: [],
  agents: [],
  issues: [],
  hasMore: false,
  detail: null,
  selectedIssueId: null,
  busy: false,
  error: null,
  ready: false,
  log: null,
  receipts: {},
});
