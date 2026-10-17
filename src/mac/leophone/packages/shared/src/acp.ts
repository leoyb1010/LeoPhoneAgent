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
