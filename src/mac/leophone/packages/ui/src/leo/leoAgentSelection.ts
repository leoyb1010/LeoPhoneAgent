import type { ModelSelectionView } from "@zcode/services";
import { ACP_PROVIDER_ID, ACP_AGENTS, isAcpAgentId, parseAcpModelId, type AcpAgentId } from "@zcode/shared/acp";

export type LeoSelectableAgent = "leobot" | AcpAgentId;
export interface LeoAgentModelSelection {
  provider: string;
  model: string;
}
export interface LeoAgentChoice {
  id: LeoSelectableAgent;
  label: string;
  available: boolean;
  selection: LeoAgentModelSelection | null;
}

const AGENTS = [
  { id: "leobot", label: "ZCode" },
  { id: "codex", label: "Codex CLI" },
  { id: "claude-code", label: "Claude Code" },
] as const;

/** 只消费目标Host的目录；缺失的CLI不借另一个Agent兜底。 */
export function resolveLeoAgentChoice(
  agent: LeoSelectableAgent,
  view: ModelSelectionView | null | undefined,
  current: LeoAgentModelSelection | null | undefined,
): LeoAgentModelSelection | null {
  if (!view) return null;
  if (agent !== "leobot") {
    const exists = view.providers.some(
      (provider) =>
        provider.providerId === ACP_PROVIDER_ID &&
        provider.models.some((model) => model.modelId === agent),
    );
    if (!exists) return null;
    if (current?.provider === ACP_PROVIDER_ID && parseAcpModelId(current.model)?.agentId === agent) {
      return current;
    }
    return { provider: ACP_PROVIDER_ID, model: agent };
  }
  const providers = view.providers.filter((provider) => provider.providerId !== ACP_PROVIDER_ID);
  if (
    current &&
    providers.some(
      (provider) =>
        provider.providerId === current.provider &&
        provider.models.some((model) => model.modelId === current.model),
    )
  )
    return current;
  // 返回默认引擎时只选目录内真实存在的模型，绝不把ACP占位模型作为默认模型。
  const preferred = view.preferredSelection;
  if (
    preferred &&
    providers.some(
      (provider) =>
        provider.providerId === preferred.providerId &&
        provider.models.some((model) => model.modelId === preferred.modelId),
    )
  ) {
    return { provider: preferred.providerId, model: preferred.modelId };
  }
  const provider = providers.find((candidate) => candidate.models.length > 0);
  const model = provider?.models[0];
  return provider && model ? { provider: provider.providerId, model: model.modelId } : null;
}

export function buildLeoAgentChoices(
  view: ModelSelectionView | null | undefined,
  current: LeoAgentModelSelection | null | undefined,
): LeoAgentChoice[] {
  const extra = (
    view?.providers.find((provider) => provider.providerId === ACP_PROVIDER_ID)?.models ?? []
  )
    .filter(
      (model) =>
        isAcpAgentId(model.modelId) && model.modelId !== "codex" && model.modelId !== "claude-code",
    )
    .map((model) => ({
      id: model.modelId as AcpAgentId,
      label: ACP_AGENTS.find((agent) => agent.id === model.modelId)?.name ?? model.modelId,
    }));
  return [...AGENTS, ...extra].map((agent) => {
    const selection = resolveLeoAgentChoice(agent.id, view, current);
    return { ...agent, selection, available: selection !== null };
  });
}

/** 已创建任务的执行引擎固定；API模型可以在同一ZCode引擎内更换。 */
export function isSameLeoAgentRoute(
  current: LeoAgentModelSelection,
  next: LeoAgentModelSelection,
): boolean {
  if (!current.provider || !next.provider) return false;
  if (current.provider === ACP_PROVIDER_ID || next.provider === ACP_PROVIDER_ID) {
    const currentAgent = parseAcpModelId(current.model)?.agentId;
    return current.provider === next.provider && currentAgent !== undefined
      && currentAgent === parseAcpModelId(next.model)?.agentId;
  }
  return true;
}

/** 草稿选择属于Composer，预热snapshot不代表用户本次选择；既有任务显示实际执行者。 */
export function resolveLeoComposerAgentSelection(
  draftMode: boolean,
  draft:
    | {
        provider?: string;
        model?: string;
        modelSelection?: { providerId: string; modelId: string };
      }
    | undefined,
  snapshot: LeoAgentModelSelection | null | undefined,
): LeoAgentModelSelection {
  const pending = {
    provider: draft?.provider ?? draft?.modelSelection?.providerId ?? "",
    model: draft?.model ?? draft?.modelSelection?.modelId ?? "",
  };
  if (draftMode) return pending;
  if (snapshot?.provider === ACP_PROVIDER_ID && isSameLeoAgentRoute(snapshot, pending)) return pending;
  return snapshot ?? { provider: "", model: "" };
}
