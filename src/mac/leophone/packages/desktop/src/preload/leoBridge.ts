import { contextBridge, ipcRenderer } from "electron";

/**
 * [leo-link] 暴露给界面的方法:查手机连接状态、给新手机出配对码、作废没用掉的码、打开订阅登录页。
 * 通道名与 main/leoLinkIpc.ts 一致;这里不引 main 的模块,preload 只依赖 electron。
 */
contextBridge.exposeInMainWorld("leoLink", {
  direct: (action: "pair" | "configure" | "revoke", body?: unknown) =>
    ipcRenderer.invoke("leo:link:direct", action, body),
  status: () => ipcRenderer.invoke("leo:link:status"),
  pair: () => ipcRenderer.invoke("leo:link:pair"),
  revoke: (payload: string) => ipcRenderer.invoke("leo:link:revoke", payload),
  /** 在系统浏览器里打开订阅账号登录页(主进程带上本次启动的口令与实际端口)。 */
  openOAuthPage: () => ipcRenderer.invoke("leo:oauth:open"),
});

/** [leo] 菜单栏与 ⌥Space 快速派发的设置(macOS;主进程持有,见 docs/specs/leo-quick-entry.md)。 */
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("leoQuick", {
    getSettings: () => ipcRenderer.invoke("leo:quick:settings:get"),
    setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("leo:quick:settings:set", patch),
    /** 菜单栏点任务 / 浮窗「派发并打开」:主进程让主窗口定位到这个任务。 */
    onOpenTask: (
      callback: (target: { taskId: string; workspacePath: string; workspaceIdentity?: string }) => void,
    ) => {
      const listener = (_event: unknown, target: { taskId: string; workspacePath: string; workspaceIdentity?: string }) =>
        callback(target);
      ipcRenderer.on("leo:quick:open-task", listener);
      return () => ipcRenderer.removeListener("leo:quick:open-task", listener);
    },
  });
}
