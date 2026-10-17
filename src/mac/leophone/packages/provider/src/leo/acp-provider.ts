// [leo][WP-21] 外部 agent（ACP）以一个合成的 Provider 出现在 Registry 里：providerId = "acp"，
// 每个 agent 一个模型（claude-code / codex / gemini / opencode）。只进 registryProviders（模型选择、
// 会话恢复、选择校验），不进 resolvedProviders——设置页的供应商列表看不到它，也不能编辑。
// 实际执行由 CLI 在 ModelFactory 处截走（apps/zcode-cli/packages/bootstrap/src/app/leo/acp.ts），
// 这里的 api 只是满足完整性校验的占位（死端口，永远不会被请求）。
import { ACP_AGENT_IDS, ACP_PROVIDER_ID } from "@zcode/shared/acp";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ModelId,
  type ProviderId,
} from "../config/index.js";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  type Provider,
} from "../resolver.js";

const ACP_MODEL_DATA = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 200_000,
    inputFormat: {
      supportsText: true,
      supportsImage: true,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["default"], map: "{}" },
    maxOutputTokens: { max: 128_000, map: "{}" },
  },
} as const;

const cache = new Map<string, Provider>();

/** agentIds 缺省为全部（CLI 侧：已存在的会话选择必须能通过校验）；UI 侧只传本机可用的。 */
export function createAcpRegistryProvider(agentIds: readonly string[] = ACP_AGENT_IDS): Provider {
  const key = agentIds.join(",");
  const cached = cache.get(key);
  if (cached) return cached;
  const config = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "acp-local-agent" }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "http://127.0.0.1:9" }),
    builtinModelIds: [...agentIds],
    visibility: "visible",
  });
  const providerResult = createRegistryProviderConfig(config, ["provider", ACP_PROVIDER_ID]);
  if (!providerResult.ok) throw new Error("ACP Provider 占位配置不完整");
  const models = agentIds.map((modelId) => {
    const result = createRegistryModelConfig(ModelConfig.fromData(ACP_MODEL_DATA), [
      "provider",
      ACP_PROVIDER_ID,
      "models",
      modelId,
    ]);
    if (!result.ok) throw new Error(`ACP 模型占位配置不完整: ${modelId}`);
    return Object.freeze({ modelId: modelId as ModelId, config: result.config });
  });
  const provider = Object.freeze({
    providerId: ACP_PROVIDER_ID as ProviderId,
    providerName: "外部 Agent",
    templateId: undefined,
    config: providerResult.config,
    models: Object.freeze(models),
  }) as Provider;
  cache.set(key, provider);
  return provider;
}
