// [leo][WP-21] ACP 外部 agent 接进会话：
//   - ModelFactory：providerId = "acp" 的选择不走 Provider 适配器，换成驱动 agent 进程的 AcpModel；
//   - 工具：每个会话注册一个对模型不可见的 AcpToolCall（审批与展示），由 AcpModel 发出。
// Registry 里的 "acp" Provider 由 provider-node 合成（packages/provider/src/leo/acp-provider.ts），
// 所以选择校验、会话恢复与 UI 模型列表都不需要特殊路径。
import { AcpModel, AcpSessionManager, type AcpProviderBinding } from "@zcode/adapters/acp";
import type { Logger } from "@zcode/contracts";
import { createAcpToolCallEntry, type ToolRegistry } from "@zcode/core";
import {
  ACP_PROVIDER_ID, ACP_TOOL_NAME, acpAgentForConfiguredProvider, isAcpModelSelection,
  parseAcpModelId, type AcpModelRoute,
} from "@zcode/shared/acp";
import type { ProviderRegistryModelSource, RuntimeModelFactory } from "../provider-registry-model-runtime.js";

let sharedManager: AcpSessionManager | undefined;

export function getAcpSessionManager(logger?: Logger): AcpSessionManager {
  if (!sharedManager) {
    sharedManager = new AcpSessionManager({
      ...(logger
        ? {
            logger: {
              warn: (message, context) => logger.warn(message, { module: "acp", ...context }),
              info: (message, context) => logger.info(message, { module: "acp", ...context }),
              debug: (message, context) => logger.debug(message, { module: "acp", ...context }),
            },
          }
        : {}),
    });
    // [fix] 以前 disposeAcpSessions 没人调用：CLI 退出（含协议层 cleanup 后的 process.exit、崩溃）时
    // agent 子进程（及其进程组）留成孤儿。exit 钩子是同步的，disposeAll 同步发 SIGTERM。
    process.once("exit", disposeAcpSessions);
  }
  return sharedManager;
}

/** 进程退出时收掉所有 agent 子进程。 */
export function disposeAcpSessions(): void {
  sharedManager?.disposeAll();
}

type AcpProviderRegistry = Pick<ProviderRegistryModelSource, "getProvider" | "getModel">;

function resolveAcpProviderBinding(
  route: AcpModelRoute,
  registry: AcpProviderRegistry,
): AcpProviderBinding | undefined {
  const providerId = route.configuredProviderId;
  if (!providerId || !route.customModelId) return;
  const provider = registry.getProvider(providerId);
  const model = registry.getModel(providerId, route.customModelId);
  if (!provider || !model?.config.enabled || provider.config.access.type !== "api-key"
    || acpAgentForConfiguredProvider(provider.config) !== route.agentId) {
    throw new Error("此 CLI 路径已无法使用选定的供应商和模型，请重新选择模型。");
  }
  return { providerId, baseUrl: provider.config.api.baseUrl, apiKey: provider.config.access.apiKey };
}

export function wrapModelFactoryForAcp(
  base: RuntimeModelFactory,
  options: { sessionId: string; workingDirectory: () => string; registry: AcpProviderRegistry; logger?: Logger },
): RuntimeModelFactory {
  return (input) => {
    const route = input.selection?.providerId === ACP_PROVIDER_ID ? parseAcpModelId(input.selection.modelId) : null;
    if (route) {
      return new AcpModel({
        agentId: route.agentId,
        customModelId: route.customModelId,
        providerBinding: resolveAcpProviderBinding(route, options.registry),
        leoSessionId: options.sessionId,
        cwd: options.workingDirectory,
        manager: getAcpSessionManager(options.logger),
      });
    }
    return base(input);
  };
}

/** 外部 agent 会话：`/命令` 是 agent 自带的命令，原样交给它，不按 LeoBot 的内置 / 自定义命令展开。 */
export function acpOwnsSlashCommands(selection: Parameters<typeof isAcpModelSelection>[0]): boolean {
  return isAcpModelSelection(selection);
}

export function registerAcpTool(registry: ToolRegistry, logger?: Logger): void {
  if (registry.has(ACP_TOOL_NAME)) return;
  registry.register(
    createAcpToolCallEntry({
      runApprovedTool: async ({ sessionId, leoToolCallId, acpToolCallId, allowAlways, signal }) => {
        const host = getAcpSessionManager(logger).host(sessionId);
        if (!host) {
          return {
            status: "failed",
            title: acpToolCallId,
            kind: "other",
            text: "外部 agent 已断开，这一步没有执行结果",
          };
        }
        return host.runApprovedTool(leoToolCallId, acpToolCallId, { allowAlways, signal });
      },
    }),
    { silentDuplicateWarning: true },
  );
}
