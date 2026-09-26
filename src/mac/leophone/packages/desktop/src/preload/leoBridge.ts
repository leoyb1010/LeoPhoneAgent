import { contextBridge, ipcRenderer } from "electron";

/**
 * [leo-link] 暴露给界面的两个方法:查手机连接状态、给新手机出配对码。
 * 通道名与 main/leoLinkIpc.ts 一致;这里不引 main 的模块,preload 只依赖 electron。
 */
contextBridge.exposeInMainWorld("leoLink", {
  status: () => ipcRenderer.invoke("leo:link:status"),
  pair: () => ipcRenderer.invoke("leo:link:pair"),
});
