// [remote-ctl-mac] 手机远控的模型 / 推理强度(docs/specs/leo-link-remote-controls.md「模型与推理强度」)。
// 模型清单与桌面模型选择器同源(IModelSelectionService.getView),这里只做换算,不留副本。
import type { ModelSelectionView } from "@zcode/services";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared";
import { ACP_PROVIDER_ID } from "@zcode/shared/acp";

/** 会话摘要 / `model` 事件里的模型;name 目前就是 modelId(注册表里没有单独的模型显示名)。 */
export type SessionModel = { provider: string; model: string; name: string; effort: string | null };

export type CatalogModel = {
  provider: string;
  provider_name: string;
  model: string;
  name: string;
  efforts: string[];
  default_effort: string | null;
};

/** 只列 LeoBot 会话能用的模型:排除合成的 acp 供应商(外部 agent)和被关掉的模型。 */
export function modelCatalog(view: ModelSelectionView): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const provider of view.providers) {
    if (provider.providerId === ACP_PROVIDER_ID) continue;
    for (const model of provider.models) {
      if ((model.config as { enabled?: boolean }).enabled === false) continue;
      const efforts = [...(model.config.optionSpecs?.reasoningLevel?.values ?? [])];
      models.push({
        provider: provider.providerId,
        provider_name: provider.providerName || provider.providerId,
        model: model.modelId,
        name: model.modelId,
        efforts,
        // 与 resolveLeoBotModelSelection 自动选择时取的档位一致(最高档)。
        default_effort: efforts.at(-1) ?? null,
      });
    }
  }
  return models;
}

export function findModel(models: readonly CatalogModel[], provider: string, model: string): CatalogModel | undefined {
  return models.find((candidate) => candidate.provider === provider && candidate.model === model);
}

export function sessionModel(selection: ModelSelection): SessionModel {
  return {
    provider: selection.providerId,
    model: selection.modelId,
    name: selection.modelId,
    effort: selection.options?.reasoningLevel ?? null,
  };
}

/** 内核 glm_agent_model_state_update 里的 "provider/model$thought";解析不了返回 null。 */
export function modelFromPicker(value: string, thought?: string): SessionModel | null {
  if (!value.trim()) return null;
  try {
    const parsed = sessionModel(parseModelPickerValue(value));
    return thought ? { ...parsed, effort: thought } : parsed;
  } catch {
    return null;
  }
}

/** 任务表里存的模型(重启后认回)。 */
export function parseSessionModel(value: unknown): SessionModel | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["provider"] !== "string" || typeof raw["model"] !== "string") return null;
  return {
    provider: raw["provider"],
    model: raw["model"],
    name: typeof raw["name"] === "string" ? raw["name"] : raw["model"],
    effort: typeof raw["effort"] === "string" ? raw["effort"] : null,
  };
}

export function sameModel(a: SessionModel | null, b: SessionModel | null): boolean {
  return a?.provider === b?.provider && a?.model === b?.model && (a?.effort ?? null) === (b?.effort ?? null);
}

export type CreateModelChoice = { selection: ModelSelection } | { error: string } | null;

/**
 * 新建任务时手机指定的模型 / 强度。null = 都没带(走自动选择)。
 * - model 不认识、effort 不在该模型的档位里 → error(400)。
 * - 旧字段 thinking 视作 effort,但只是尽力而为:不认识的值静默忽略(旧 iPhone 的取值不受这份契约约束)。
 */
export function createModelChoice(
  body: Record<string, unknown>,
  models: readonly CatalogModel[],
  fallback: ModelSelection | null | undefined,
): CreateModelChoice {
  const rawModel = body["model"];
  const explicitEffort = typeof body["effort"] === "string" ? body["effort"].trim() : "";
  const legacyEffort = typeof body["thinking"] === "string" ? body["thinking"].trim() : "";
  if (rawModel == null && !explicitEffort && !legacyEffort) return null;
  let target: CatalogModel | undefined;
  if (rawModel != null) {
    const spec = rawModel && typeof rawModel === "object" ? (rawModel as Record<string, unknown>) : {};
    if (typeof spec["provider"] !== "string" || typeof spec["model"] !== "string")
      return { error: "model 必须是 {provider, model}" };
    target = findModel(models, spec["provider"], spec["model"]);
    if (!target) return { error: `这台 Mac 上没有模型「${spec["provider"]}/${spec["model"]}」` };
  } else if (fallback) {
    target = findModel(models, fallback.providerId, fallback.modelId);
  }
  if (!target) return null;
  const effort = explicitEffort || legacyEffort;
  if (explicitEffort && !target.efforts.includes(explicitEffort))
    return { error: `模型「${target.name}」不支持推理强度「${explicitEffort}」` };
  const reasoningLevel = effort && target.efforts.includes(effort) ? effort : (rawModel == null ? fallback?.options?.reasoningLevel : target.default_effort) ?? undefined;
  return {
    selection: {
      providerId: target.provider,
      modelId: target.model,
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
  };
}
