import {
  reconcileRuntimeDraftWithCapabilities as reconcileSharedRuntimeDraft,
  type MobileAgentCapabilities,
  type MobileRuntimeDraft,
} from '@cindy/maker-shared/agent-capabilities';

export {
  MOBILE_MODEL_CATEGORY_LABEL,
  buildMobileModelSwitchConfirmation,
  buildSessionRuntimeOptions,
  categorizeMobileModel,
  isMobileHistoryCompatibleModelSwitch,
  normalizeMobileAgentCapabilities,
  type MobileChoiceOption,
  type MobileModelCategory,
  type MobileModelOption,
  type MobileModelSwitchConfirmation,
  type MobileSessionRuntimeOptions,
} from '@cindy/maker-shared/agent-capabilities';

export type { MobileAgentCapabilities, MobileRuntimeDraft };

export interface MobileRuntimeReconcileOptions {
  /**
   * 当前页面刚由 provider 目录显式选中的模型可短暂保留，等待 capabilities descriptor
   * 追上。持久草稿不得开启，否则已下架模型会逃过 mobile 的首项降级。
   */
  preserveUnknownModel?: boolean;
}

/**
 * Mobile 新会话草稿协调器。
 *
 * shared 层保留未知显式模型以避免 provider/capabilities 短暂错代；mobile 额外拥有
 * 持久草稿，必须把目录已确认移除的陈旧模型降级，否则 createSession 会收到失效 id。
 */
export function reconcileRuntimeDraftWithCapabilities<
  T extends MobileRuntimeDraft & { providerId?: string | null },
>(
  draft: T,
  capabilities: MobileAgentCapabilities | null,
  options: MobileRuntimeReconcileOptions = {},
): T {
  const modelAvailable = capabilities?.availableModels.some((model) => model.id === draft.model);
  if (
    !capabilities
    || !draft.model
    || modelAvailable
    || options.preserveUnknownModel === true
    || capabilities.availableModels.length === 0
  ) {
    return reconcileSharedRuntimeDraft(draft, capabilities);
  }

  // 目录与完整 capabilities 都不再包含该模型：用空 model 触发 shared 的首项降级，
  // 同时清掉与旧模型绑定的显式来源，交给被控端重新选择默认路由。
  const fallbackDraft = {
    ...draft,
    model: '',
    ...('providerId' in draft ? { providerId: null } : {}),
  } as T;
  return reconcileSharedRuntimeDraft(fallbackDraft, capabilities);
}
