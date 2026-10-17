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
  /** [WP-50]「允许手机查看屏幕」开关与屏幕录制权限状态。 */
  screenStatus: () => ipcRenderer.invoke("leo:screen:status"),
  setScreenEnabled: (enabled: boolean) => ipcRenderer.invoke("leo:screen:set", enabled),
  openScreenSettings: () => ipcRenderer.invoke("leo:screen:open-settings"),
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

/** [leo] 设置 → MCP 的「推荐：iMCP」卡片:查本机有没有装 iMCP(主进程只读文件系统,不替用户安装)。 */
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("leoImcp", {
    status: () => ipcRenderer.invoke("leo:imcp:status"),
  });
}

/** [leo][WP-21] 外部 agent（ACP）：本机可用列表与「在终端登录」。 */
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("leoAcp", {
    list: () => ipcRenderer.invoke("leo:acp:list"),
    login: (agentId: string) => ipcRenderer.invoke("leo:acp:login", agentId),
    /** agent 自带的斜杠命令（外部 agent 会话里输入 / 时列出）。 */
    commands: (agentId: string, cwd: string) => ipcRenderer.invoke("leo:acp:commands", agentId, cwd),
  });
}

/** [leo][WP-27] 并行任务组:多个 agent 各在一个 git worktree 里做同一件事,对比后采纳一个。 */
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("leoTaskGroups", {
    call: (action: "list" | "create" | "diff" | "merge" | "cleanup", body?: unknown) =>
      ipcRenderer.invoke("leo:groups", action, body),
  });
}

/** [leo][WP-22] 设置「电脑操作」:随包 Peekaboo 的权限状态与系统设置入口。 */
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("leoComputerUse", {
    status: () => ipcRenderer.invoke("leo:computer-use:status"),
    openSettings: (key: string) => ipcRenderer.invoke("leo:computer-use:open-settings", key),
  });
}

/** [leo][WP-60] 按住快捷键说话(写进输入框)与回复朗读;助手程序由主进程拉起。 */
if (process.platform === "darwin") {
  const subscribe = (channel: string) => (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
  contextBridge.exposeInMainWorld("leoSpeech", {
    getSettings: () => ipcRenderer.invoke("leo:speech:settings:get"),
    setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("leo:speech:settings:set", patch),
    start: () => ipcRenderer.invoke("leo:speech:start"),
    stop: () => ipcRenderer.invoke("leo:speech:stop"),
    onEvent: subscribe("leo:speech:event"),
    speak: (markdown: string) => ipcRenderer.invoke("leo:speech:speak", markdown),
    stopSpeaking: () => ipcRenderer.invoke("leo:speech:stop-speaking"),
    onSpeakState: subscribe("leo:speech:speak-state"),
    openMicSettings: () => ipcRenderer.invoke("leo:speech:open-mic-settings"),
  });
}
