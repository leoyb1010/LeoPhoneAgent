// [fix-remote] LeoBot 自己的任务（手机 harness=zcode、并行计划里的 LeoBot 成员）用哪个模型。
// 不传模型时内核取 registry 里第一个可选模型；在没配个人供应商的 Mac 上那就是合成的 acp/claude-code，
// LeoBot 任务会被悄悄转给 Claude Code。这里显式选：用户在 Mac 上设的默认（provider-node 的初始推荐已排除 acp），
// 否则第一个非 acp 的可用模型；一个都没有返回 null，由调用方给出「去配置模型」的提示。
import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";
import { ACP_PROVIDER_ID } from "@zcode/shared/acp";

export const LEOBOT_NO_MODEL_MESSAGE =
  "这台 Mac 上 LeoBot 还没配置模型：在 Mac 的 设置 → AI 服务商 添加，或在 iPhone 上用『全部发送到 Mac』";

export async function resolveLeoBotModelSelection(
  service: Pick<IModelSelectionService, "getView">,
): Promise<ModelSelection | null> {
  const view = await service.getView({ selection: null });
  const preferred = view.preferredSelection;
  if (preferred && preferred.providerId !== ACP_PROVIDER_ID) return preferred;
  for (const provider of view.providers) {
    if (provider.providerId === ACP_PROVIDER_ID) continue;
    for (const model of provider.models) {
      const reasoningLevel = model.config.optionSpecs?.reasoningLevel?.values?.at(-1);
      return {
        providerId: provider.providerId,
        modelId: model.modelId,
        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
      };
    }
  }
  return null;
}
