import { emptyPaperclipSnapshot } from "./commands.js";
import type {
  PaperclipBinding,
  PaperclipPersistence,
  PaperclipProfile,
  PaperclipReceipt,
} from "./contract.js";
import {
  bindingKey,
  canonicalPaperclipServer,
  object,
  string,
  PaperclipFailure,
} from "./protocol.js";
const PROFILE = "leophone.paperclip.profile.v1";
const RECEIPTS = "leophone.paperclip.receipts.v1";
export function readProfile(storage: PaperclipPersistence): PaperclipProfile | null {
  const raw = storage.getItem(PROFILE);
  if (!raw) return null;
  const value = object(JSON.parse(raw));
  return { serverUrl: canonicalPaperclipServer(string(value.serverUrl)), name: string(value.name) };
}
export function saveProfile(storage: PaperclipPersistence, profile: PaperclipProfile): void {
  storage.setItem(PROFILE, JSON.stringify(profile));
}
export function readReceipts(storage: PaperclipPersistence): PaperclipReceipt[] {
  const raw = storage.getItem(RECEIPTS);
  if (!raw) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data))
    throw new Error("待核实操作记录损坏；请保留应用数据并联系支持，不能继续提交");
  for (const entry of data) {
    const row = object(entry);
    string(row.id);
    string(row.createdAt);
    const binding = object(row.binding);
    canonicalPaperclipServer(string(binding.serverUrl));
    string(binding.companyId);
    string(binding.userId);
    const c = object(row.command);
    if (!["create", "reply", "status", "approve", "reject", "cancel"].includes(string(c.kind)))
      throw new Error("待核实操作类型无法识别");
    if (c.kind === "create") {
      string(c.title);
      string(c.agentId);
      if (typeof c.description !== "string") throw new Error("任务记录无法识别");
    } else {
      string(c.issueId);
      if (c.kind === "reply") string(c.body);
      if (c.kind === "status") string(c.status);
      if (c.kind === "cancel") string(c.runId);
      if (c.kind === "approve" || c.kind === "reject") {
        string(c.approvalId);
        string(c.expectedApproval);
        if (typeof c.decisionNote !== "string") throw new Error("审批记录无法识别");
      }
    }
    if (row.state !== "acknowledged") row.state = "uncertain"; // 进程退出不能证明上次发送失败。
  }
  return data as PaperclipReceipt[];
}
export function saveReceipts(storage: PaperclipPersistence, receipts: PaperclipReceipt[]): void {
  try {
    storage.setItem(RECEIPTS, JSON.stringify(receipts));
  } catch {
    throw new Error("无法保存操作回执，已阻止发送；请检查本机存储空间");
  }
}

export function recordMutationFailure(
  storage: PaperclipPersistence,
  receipts: PaperclipReceipt[],
  receipt: PaperclipReceipt,
  error: unknown,
  retainReceipt: boolean,
): PaperclipReceipt[] {
  // 只有首次发送的明确拒绝可认为未提交；核实期间的 4xx 不能否定之前的提交。
  const rejected =
    !retainReceipt &&
    error instanceof PaperclipFailure &&
    [400, 403, 404, 422, 429].includes(error.status);
  const next = rejected ? receipts.filter((r) => r.id !== receipt.id) : receipts;
  if (!rejected) receipt.state = "uncertain";
  saveReceipts(storage, next);
  return next;
}

export function restorePaperclipWorkspace(storage: PaperclipPersistence) {
  const state = emptyPaperclipSnapshot();
  let receipts: PaperclipReceipt[] = [];
  try {
    receipts = readReceipts(storage);
    state.profile = readProfile(storage);
    state.connection = state.profile ? "signed-out" : "unconfigured";
  } catch {
    state.error = "本地连接配置或待核实操作无法读取。请保留应用数据并联系支持，暂不能提交操作";
  }
  return { state, receipts };
}
export function findPaperclipReceipt(
  receipts: PaperclipReceipt[],
  binding: PaperclipBinding | null,
): PaperclipReceipt | null {
  return binding
    ? (receipts.find(
        (r) => r.state !== "acknowledged" && bindingKey(r.binding) === bindingKey(binding),
      ) ?? null)
    : null;
}
