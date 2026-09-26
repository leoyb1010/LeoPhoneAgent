import type { ZCodeTaskMeta } from "@zcode/shared";

import { getTaskListAttention, isTaskListRowActive } from "../v4/taskListRowActivity.js";

/** [leo] 首页「进行中」清单的分组:等你确认 / 回答 → 在跑 → 做完没看。同组内保持传入顺序(按更新时间)。 */
export type LeoStatusState = "attention" | "running" | "done";

export interface LeoStatusRow {
  task: ZCodeTaskMeta;
  state: LeoStatusState;
  label: string;
}

export function classifyLeoStatusRows(items: readonly ZCodeTaskMeta[]): LeoStatusRow[] {
  const attention: LeoStatusRow[] = [];
  const running: LeoStatusRow[] = [];
  const done: LeoStatusRow[] = [];
  for (const task of items) {
    const pending = getTaskListAttention(task);
    if (pending) {
      attention.push({
        task,
        state: "attention",
        label: pending.kind === "userInput" ? "等你回答" : "等你确认",
      });
    } else if (isTaskListRowActive(task)) {
      running.push({ task, state: "running", label: "在跑" });
    } else if (task.unreadAt) {
      done.push({ task, state: "done", label: "做完待看" });
    }
  }
  return [...attention, ...running, ...done];
}

