/**
 * [leo] ⌥Space 快速派发浮窗的 preload(见 docs/specs/leo-quick-entry.md)。
 * 只暴露浮窗要的三件事,不复用主窗口的大 preload;通道名与 main/leo/quickEntry.ts 一致。
 */
import { contextBridge, ipcRenderer } from "electron";

export interface LeoQuickPanelState {
  workspaces: string[];
  selected: string | null;
  error: string | null;
}

contextBridge.exposeInMainWorld("leoQuickPanel", {
  onState: (callback: (state: LeoQuickPanelState) => void) => {
    const listener = (_event: unknown, state: LeoQuickPanelState) => callback(state);
    ipcRenderer.on("leo:quick:panel:state", listener);
    return () => ipcRenderer.removeListener("leo:quick:panel:state", listener);
  },
  dispatch: (payload: { prompt: string; workspacePath: string | null; open: boolean }) =>
    ipcRenderer.invoke("leo:quick:panel:dispatch", payload),
  hide: (reason: "escape" | "dispatched") => ipcRenderer.send("leo:quick:panel:hide", reason),
});
