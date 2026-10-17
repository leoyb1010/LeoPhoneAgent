import type { ZCodeTaskMeta } from "@zcode/shared";

import { getTaskListAttention, getTaskListRowActivity, isTaskListRowActive } from "../v4/taskListRowActivity.js";

import { deriveTaskLeadingIndicator } from "../lib/taskListItemPresentation.js";
import { resolveLeoAgentKind, type LeoAgentKind } from "./leoAgentKind.js";

/** [leo] 首页「进行中」清单的分组:等你确认 / 回答 → 出错待看 → 在跑 → 已结束待看。同组内保持传入顺序(按更新时间)。 */
export type LeoStatusState = "attention" | "running" | "error" | "done";

export interface LeoStatusRow {
  task: ZCodeTaskMeta;
  state: LeoStatusState;
  label: string;
  /** [wp-31] 状态行徽标;ACP 合入前恒为 LeoBot。 */
  agentKind: LeoAgentKind;
}

/** [wp-31] 首页「最近工作区」卡:每个工作区取最近更新的一条任务,一键继续。 */
export interface LeoRecentWorkspace {
  key: string;
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  agentKind: LeoAgentKind;
}

export const LEO_RECENT_WORKSPACE_LIMIT = 5;

/** items 已按更新时间倒序;同一工作区(按 identity ?? path 去重)只留第一条,最多 5 个。 */
export function pickLeoRecentWorkspaces(
  items: readonly ZCodeTaskMeta[],
  limit: number = LEO_RECENT_WORKSPACE_LIMIT,
): LeoRecentWorkspace[] {
  const seen = new Set<string>();
  const result: LeoRecentWorkspace[] = [];
  for (const task of items) {
    const key = task.workspaceIdentity?.trim() || task.workspacePath;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      task,
      agentKind: resolveLeoAgentKind(task),
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function classifyLeoStatusRows(items: readonly ZCodeTaskMeta[]): LeoStatusRow[] {
  const attention: LeoStatusRow[] = [];
  const running: LeoStatusRow[] = [];
  const done: LeoStatusRow[] = [];
  const failed: LeoStatusRow[] = [];
  for (const task of items) {
    const pending = getTaskListAttention(task);
    if (pending) {
      attention.push({
        task,
        state: "attention",
        label: pending.kind === "userInput" ? "等你回答" : "等你确认",
        agentKind: resolveLeoAgentKind(task),
      });
    } else if (task.unreadAt && deriveTaskLeadingIndicator(task, getTaskListRowActivity(task)) === "error") {
      // 与侧栏共用实时结果权威：失败不是成功完成，旧落盘错误不能盖过已恢复的运行。
      failed.push({ task, state: "error", label: "出错待看", agentKind: resolveLeoAgentKind(task) });
    } else if (isTaskListRowActive(task)) {
      running.push({ task, state: "running", label: "在跑", agentKind: resolveLeoAgentKind(task) });
    } else if (task.unreadAt) {
      done.push({ task, state: "done", label: "做完待看", agentKind: resolveLeoAgentKind(task) });
    }
  }
  return [...attention, ...failed, ...running, ...done];
}

