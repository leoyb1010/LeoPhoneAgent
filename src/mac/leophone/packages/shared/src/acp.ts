// [leo][WP-21] ACP 外部 agent 的共享定义（UI / services / CLI 共用，只依赖 zod-free 常量）。
// 外部 agent 会话在 ZCode 运行时里托管：会话的模型选择 providerId = "acp"，modelId = agent id。
// 这样持久化、对话投影、审批卡、任务列表与 Leo Link 全部复用现有链路。

export const ACP_PROVIDER_ID = "acp";
export const ACP_REASONING_LEVEL = "default";
export const ACP_TOOL_NAME = "AcpToolCall";

export const ACP_AGENT_IDS = ["claude-code", "codex", "gemini", "opencode"] as const;
export type AcpAgentId = (typeof ACP_AGENT_IDS)[number];

export interface AcpAgentInfo {
  id: AcpAgentId;
  name: string;
  /** 手机端 harness key（Leo Link 协议字段同名，见 host/leo/link/bridge.ts）。 */
  harnessKey: string;
}

export const ACP_AGENTS: readonly AcpAgentInfo[] = [
  { id: "claude-code", name: "Claude Code", harnessKey: "claude" },
  { id: "codex", name: "Codex", harnessKey: "codex" },
  { id: "gemini", name: "Gemini", harnessKey: "gemini" },
  { id: "opencode", name: "opencode", harnessKey: "opencode" },
];

export function isAcpAgentId(value: unknown): value is AcpAgentId {
  return typeof value === "string" && (ACP_AGENT_IDS as readonly string[]).includes(value);
}

export function acpAgentInfo(id: AcpAgentId): AcpAgentInfo {
  return ACP_AGENTS.find((agent) => agent.id === id)!;
}

export function acpAgentByHarnessKey(key: string): AcpAgentInfo | undefined {
  return ACP_AGENTS.find((agent) => agent.harnessKey === key || agent.id === key);
}

export interface AcpModelSelectionLike {
  providerId: string;
  modelId: string;
}

export function isAcpModelSelection(
  selection: AcpModelSelectionLike | null | undefined,
): selection is AcpModelSelectionLike & { modelId: AcpAgentId } {
  return selection?.providerId === ACP_PROVIDER_ID && isAcpAgentId(selection.modelId);
}

export function acpModelSelection(id: AcpAgentId): {
  providerId: string;
  modelId: AcpAgentId;
  options: { reasoningLevel: string };
} {
  return { providerId: ACP_PROVIDER_ID, modelId: id, options: { reasoningLevel: ACP_REASONING_LEVEL } };
}

/** ACP 工具调用（AcpToolCall）的入参：由 CLI 的 ACP 模型发出，UI 渲染器读取。 */
export interface AcpToolCallInput {
  agentId: AcpAgentId;
  acpToolCallId: string;
  /** 交给运行时的工具调用 id（同一 ACP 调用晚到的授权会以新 id 再交一次）。 */
  leoToolCallId: string;
  title: string;
  kind: string;
  /** ACP agent 为这一步向客户端请求了授权（走 LeoBot 的权限档与审批卡）。 */
  needsApproval: boolean;
  command?: string;
  path?: string;
  diff?: { path: string; oldText?: string | null; newText: string };
}

/** AcpToolCall 的输出：执行结果摘要。 */
export interface AcpToolCallOutput {
  status: "completed" | "failed" | "cancelled";
  title: string;
  kind: string;
  text: string;
  diffs?: Array<{ path: string; oldText?: string | null; newText: string }>;
}

/**
 * agent 自带的斜杠命令（ACP available_commands_update）。CLI 收到后按 agent + 工作目录记进
 * <数据根>/cli/acp-commands.json；界面在外部 agent 的会话里输入 / 时列出它们，选中后原样发给 agent。
 */
export interface AcpAgentCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface AcpCommandsStore {
  version: 1;
  agents: Partial<Record<string, Record<string, { commands: AcpAgentCommand[]; updatedAt: number }>>>;
}

export const ACP_COMMANDS_FILE = "acp-commands.json";
const ACP_COMMANDS_CWD_LIMIT = 20;

export function emptyAcpCommandsStore(): AcpCommandsStore {
  return { version: 1, agents: {} };
}

export function parseAcpCommandsStore(raw: unknown): AcpCommandsStore {
  const record = raw && typeof raw === "object" ? (raw as Partial<AcpCommandsStore>) : {};
  return record.version === 1 && record.agents && typeof record.agents === "object"
    ? { version: 1, agents: record.agents }
    : emptyAcpCommandsStore();
}

/** 记下某个 agent 在某个目录下最新的命令表（每个 agent 只留最近的若干个目录）。 */
export function recordAcpAgentCommands(
  store: AcpCommandsStore,
  agentId: AcpAgentId,
  cwd: string,
  commands: readonly AcpAgentCommand[],
  now = Date.now(),
): AcpCommandsStore {
  const entries = { ...store.agents[agentId], [cwd]: { commands: [...commands], updatedAt: now } };
  const kept = Object.entries(entries)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, ACP_COMMANDS_CWD_LIMIT);
  return { version: 1, agents: { ...store.agents, [agentId]: Object.fromEntries(kept) } };
}

/** 这个目录记过就用它；没记过（这个目录还没开过该 agent 的会话）退回该 agent 最近一次的命令表。 */
export function pickAcpAgentCommands(store: AcpCommandsStore, agentId: string, cwd: string): AcpAgentCommand[] {
  const entries = store.agents[agentId];
  if (!entries) return [];
  const exact = entries[cwd];
  if (exact) return exact.commands;
  const latest = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest?.commands ?? [];
}
