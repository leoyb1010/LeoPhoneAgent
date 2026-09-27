import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMode } from "@zcode/shared";

/** 桌面上开的任务:手机列表里能看到,点开或发消息时桥接当场接过来。 */
export type DesktopTask = {
  taskId: string;
  cwd: string;
  title: string;
  status: string;
  mode: ZCodeTaskMode;
  createdAt: number;
  updatedAt: number;
};

const DESKTOP_TASK_LIMIT = 20;

/** Mac 最近打开的项目里的任务,最近更新的在前。 */
export async function fetchDesktopTasks(taskService: IZCodeTaskService, workspaces: string[]): Promise<DesktopTask[]> {
  if (workspaces.length === 0) return [];
  const result = await taskService.listTaskList({
    kind: "timeline",
    workspaceScopes: workspaces.map((workspacePath) => ({ workspacePath })),
    sortBy: "updated",
    limit: DESKTOP_TASK_LIMIT,
  });
  return result.items.map((item): DesktopTask => ({
    taskId: item.taskId,
    cwd: item.workspacePath,
    title: item.title,
    // 没在跑的桌面任务报 "available" 而不是 "idle":手机首页和 Siri 把 idle 当成"进行中",
    // 最近 20 个桌面任务会把首页刷满;available 只出现在 Mac 控制台的列表里,点开即接管。
    status: item.status === "running" ? "running" : "available",
    mode: item.mode,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}
