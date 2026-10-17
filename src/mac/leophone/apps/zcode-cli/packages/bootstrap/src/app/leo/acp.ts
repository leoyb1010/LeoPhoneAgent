// [leo][WP-21] ACP 外部 agent 接进会话：
//   - ModelFactory：providerId = "acp" 的选择不走 Provider 适配器，换成驱动 agent 进程的 AcpModel；
//   - 工具：每个会话注册一个对模型不可见的 AcpToolCall（审批与展示），由 AcpModel 发出。
// Registry 里的 "acp" Provider 由 provider-node 合成（packages/provider/src/leo/acp-provider.ts），
// 所以选择校验、会话恢复与 UI 模型列表都不需要特殊路径。
import { AcpModel, AcpSessionManager } from "@zcode/adapters/acp";
import type { Logger } from "@zcode/contracts";
import { createAcpToolCallEntry, type ToolRegistry } from "@zcode/core";
import { ACP_TOOL_NAME, isAcpModelSelection } from "@zcode/shared/acp";
import type { RuntimeModelFactory } from "../provider-registry-model-runtime.js";

let sharedManager: AcpSessionManager | undefined;

export function getAcpSessionManager(logger?: Logger): AcpSessionManager {
  sharedManager ??= new AcpSessionManager({
    ...(logger
      ? { logger: { warn: (message, context) => logger.warn(message, { module: "acp", ...context }) } }
      : {}),
  });
  return sharedManager;
}

/** 进程退出时收掉所有 agent 子进程。 */
export function disposeAcpSessions(): void {
  sharedManager?.disposeAll();
}

export function wrapModelFactoryForAcp(
  base: RuntimeModelFactory,
  options: { sessionId: string; workingDirectory: () => string; logger?: Logger },
): RuntimeModelFactory {
  return (input) => {
    if (isAcpModelSelection(input.selection)) {
      return new AcpModel({
        agentId: input.selection.modelId,
        leoSessionId: options.sessionId,
        cwd: options.workingDirectory,
        manager: getAcpSessionManager(options.logger),
      });
    }
    return base(input);
  };
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
