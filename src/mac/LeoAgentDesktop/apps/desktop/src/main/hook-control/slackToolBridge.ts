/**
 * hook-control/slackToolBridge.ts
 * ---------------------------------------------------------------------------
 * Slack 网关工具的进程内注册表(零依赖叶子模块)。
 *
 * 为什么不直接 import ipc.ts: mcp-providers.ts 被 maker-host 引, 而
 * hook-control/ipc.ts 又 import getMaker —— 静态引用会闭环; provider 的
 * isEnabled 是同步调用, ssh 式的 lazy import() 也不适用(且 main 进程禁运行时
 * 动态 import)。本模块只持有一个可空引用: ipc.ts ensureInstances 时注册
 * (委托给 HookControlManager), dispose 时注销; cindy_slack provider 经
 * getSlackToolBridge() 取用, 桥未注册 = fail-closed(工具面不可用)。
 */

import type {
  HookBindingView,
} from '../../shared/hookControlIpc.js';
import type { HookSlackToolAvailability, HookSlackToolResult } from './manager.js';

/** cindy_slack provider 消费的桥接面(与 manager 的工具 API 同形)。 */
export interface SlackToolBridge {
  availability(): HookSlackToolAvailability;
  /** teamId: (multi-team)以哪个 workspace 身份执行; 缺省 = 设备唯一绑定。 */
  callTool(
    tool: string,
    args?: Record<string, unknown>,
    teamId?: string | null,
  ): Promise<HookSlackToolResult>;
}

export type { HookBindingView, HookSlackToolAvailability, HookSlackToolResult };

let bridge: SlackToolBridge | null = null;

/** 注册桥(hook-control ipc 组装时调用; 重复注册以最新为准)。 */
export function registerSlackToolBridge(b: SlackToolBridge): void {
  bridge = b;
}

/** 注销桥(disposeHookControl 时调用)。 */
export function unregisterSlackToolBridge(): void {
  bridge = null;
}

/** 取当前桥; null = hook-control 未初始化(fail-closed)。 */
export function getSlackToolBridge(): SlackToolBridge | null {
  return bridge;
}
