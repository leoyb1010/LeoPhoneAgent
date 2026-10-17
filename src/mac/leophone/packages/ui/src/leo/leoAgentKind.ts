/**
 * [leo][wp-31] 任务由哪种 agent 在跑。ACP(WP-21)合入前只有 LeoBot 自己的 ZCode 内核,
 * 所以一律是 "leobot";ACP 合入后由任务元数据给出 agentKind,这里的映射表补上对应徽标即可。
 */
export type LeoAgentKind = "leobot" | "claude-code" | "codex" | "gemini" | "opencode";

export const LEO_DEFAULT_AGENT_KIND: LeoAgentKind = "leobot";

const LEO_AGENT_KIND_LABELS: Record<LeoAgentKind, string> = {
  leobot: "LeoBot",
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "opencode",
};

export function isLeoAgentKind(value: unknown): value is LeoAgentKind {
  return typeof value === "string" && Object.hasOwn(LEO_AGENT_KIND_LABELS, value);
}

/**
 * 从任务元数据读 agentKind;没有就看任务的模型:外部 agent 会话的模型是 `acp/<agent>`
 * (tasks-index 里可能带 `$<思考档位>` 后缀)。都认不出就是默认的 LeoBot。
 */
export function resolveLeoAgentKind(task: unknown): LeoAgentKind {
  if (task && typeof task === "object" && "agentKind" in task) {
    const value = (task as { agentKind?: unknown }).agentKind;
    if (isLeoAgentKind(value)) return value;
  }
  if (task && typeof task === "object" && "model" in task) {
    const model = (task as { model?: unknown }).model;
    const match = typeof model === "string" ? /^acp\/([^$]+)/.exec(model) : null;
    if (match && isLeoAgentKind(match[1]) && match[1] !== "leobot") return match[1];
  }
  return LEO_DEFAULT_AGENT_KIND;
}

export function leoAgentKindLabel(kind: LeoAgentKind): string {
  return LEO_AGENT_KIND_LABELS[kind];
}
