import type { ZCodeTaskMeta } from "@zcode/shared";

import { getTaskListAttention, getTaskListRowActivity, isTaskListRowActive } from "../v4/taskListRowActivity.js";

import { deriveTaskLeadingIndicator } from "../lib/taskListItemPresentation.js";

/** [leo] 首页「进行中」清单的分组:等你确认 / 回答 → 出错待看 → 在跑 → 已结束待看。同组内保持传入顺序(按更新时间)。 */
export type LeoStatusState = "attention" | "running" | "error" | "done";

export interface LeoStatusRow {
  task: ZCodeTaskMeta;
  state: LeoStatusState;
  label: string;
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
      });
    } else if (task.unreadAt && deriveTaskLeadingIndicator(task, getTaskListRowActivity(task)) === "error") {
      // 与侧栏共用实时结果权威：失败不是成功完成，旧落盘错误不能盖过已恢复的运行。
      failed.push({ task, state: "error", label: "出错待看" });
    } else if (isTaskListRowActive(task)) {
      running.push({ task, state: "running", label: "在跑" });
    } else if (task.unreadAt) {
      done.push({ task, state: "done", label: "做完待看" });
    }
  }
  return [...attention, ...failed, ...running, ...done];
}

