// [leo][WP-27] 并行任务组:界面 → 主进程 → Host(带内存口令)。任务组状态只在 Host。
import { ipcMain } from "electron";

import { callLeoGroups, isTrustedLeoSender } from "../leoLinkIpc.js";

const ACTIONS = ["list", "create", "diff", "merge", "cleanup"] as const;
type Action = (typeof ACTIONS)[number];

export function registerTaskGroupsIpc(): void {
  ipcMain.handle("leo:groups", async (event, action: unknown, body: unknown) => {
    if (!isTrustedLeoSender(event)) return { ok: false, error: "forbidden" };
    if (!(ACTIONS as readonly unknown[]).includes(action)) return { ok: false, error: "unknown action" };
    return callLeoGroups(action as Action, body);
  });
}
