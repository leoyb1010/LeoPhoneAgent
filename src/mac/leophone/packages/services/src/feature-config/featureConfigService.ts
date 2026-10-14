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
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env });
    },
  };
}
