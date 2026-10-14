import type { ModelConfigObject } from "@zcode/provider";
import {
  buildRecommendedModelConfigPatch,
  type DiscoveredModel,
} from "@zcode/shared/model-discovery";

/**
 * [leo] 从接口获取的模型按「智能配置」添加(useRecommendedConfig=true),
 * 只在 models.dev 有确切数据时补上上下文窗口、最大输出和图片输入;其余字段继续跟随推荐规则。
 */
export function resolveDiscoveredModelConfig(model: DiscoveredModel): ModelConfigObject {
  return buildRecommendedModelConfigPatch({
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
    ...(model.capabilities?.vision === undefined ? {} : { vision: model.capabilities.vision }),
  });
}
