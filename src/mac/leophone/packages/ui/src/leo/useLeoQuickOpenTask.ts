import { useEffect, useRef } from "react";

type OpenTaskTarget = { taskId: string; workspacePath: string; workspaceIdentity?: string };

/**
 * [leo] 菜单栏点任务 / ⌥Space「派发并打开」:主进程经 leoQuick bridge 让主窗口定位到任务。
 * 用侧栏同一个 handleSelectTask,会按 workspacePath / workspaceIdentity 切到对应工作区 tab。
 * 通知点击那条通道只按 taskId 反查旧 store 缓存,新建的任务查不到,所以这里单独走。
 */
export function useLeoQuickOpenTask(
  selectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void,
): void {
  const selectRef = useRef(selectTask);
  selectRef.current = selectTask;
  useEffect(() => {
    const bridge = (
      window as unknown as {
        leoQuick?: { onOpenTask?: (callback: (target: OpenTaskTarget) => void) => () => void };
      }
    ).leoQuick;
    return bridge?.onOpenTask?.((target) => {
      if (!target?.taskId || !target.workspacePath) return;
      selectRef.current(target.workspacePath, target.taskId, target.workspaceIdentity);
    });
  }, []);
}
