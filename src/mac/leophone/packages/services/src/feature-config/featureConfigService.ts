import { resolveDynamicWorkflowClientConfig } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { IFeatureConfigService } from "./featureConfig.js";

const EMPTY_MODEL_SELECTION_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});

export function createFeatureConfigService(
  dependencies: {
    resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
    /** 动态工作流的用户选择（本机设置文件）；desktop-attached remote Host 不注入，由桌面推送。 */
    resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
    env?: NodeJS.ProcessEnv;
  } = {},
): IFeatureConfigService {
  const env = dependencies.env ?? process.env;
  return {
    async getOffPeakClientConfig() {
      if (env["ZCODE_OFFPEAK_MOCK"] !== "1") {
        return { enabled: false, modelSelectionView: EMPTY_MODEL_SELECTION_VIEW };
      }
      const modelSelectionView =
        (await dependencies.resolveOffPeakModelSelectionView?.()) ?? EMPTY_MODEL_SELECTION_VIEW;
      return {
        enabled: modelSelectionView.providers.some((provider) => provider.models.length > 0),
        modelSelectionView,
      };
    },
    async getDynamicWorkflowClientConfig() {
      // 3.15.1：offer 本地裁决，用户在设置里的选择（跟随 / 关闭 / 按需 / 常开）叠加在 offer 上。
      const userMode = await dependencies.resolveDynamicWorkflowUserMode?.().catch(() => undefined);
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env, userMode });
    },
  };
}
