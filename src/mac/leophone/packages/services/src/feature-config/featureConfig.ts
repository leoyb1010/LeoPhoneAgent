import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
}

/**
 * [leo] 功能开关读取。上游这些开关挂在 Coding Plan 订阅服务上、由官方 client/configs 下发；
 * LeoPhoneAgent 不连官方服务器，订阅 / 购买接口整体删除，只留本地裁决的开关。
 */
export interface IFeatureConfigService {
  /** 闲时任务开关：本地默认关闭，只有 `ZCODE_OFFPEAK_MOCK=1` 演示模式打开。 */
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /** 动态工作流开关：本地覆盖（`ZCODE_DYNAMIC_WORKFLOW_MODE`）优先，否则取本地默认。 */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
}

export const IFeatureConfigService = createServiceDescriptor<IFeatureConfigService>(
  ServiceChannels.FeatureConfig,
);
