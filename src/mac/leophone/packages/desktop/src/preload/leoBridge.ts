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
