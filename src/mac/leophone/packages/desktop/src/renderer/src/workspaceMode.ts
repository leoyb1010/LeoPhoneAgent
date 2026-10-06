/**
 * [leo] 窗口显示哪个工作台:本机工作台(默认)还是服务器任务(Paperclip)。
 *
 * 本机 Host(手机连接、藏宝阁、订阅代理、定时任务)不论显示哪个都在跑,这里只决定界面。
 * 首次启动一律本机;用户切换后记住上次的选择。URL 上的 `workspaceMode` 只作显式覆盖
 * (测试与旧链接),切换时会被清掉,避免 reload 后被旧参数钉住。
 */
export type WorkspaceMode = "local" | "server";

export const WORKSPACE_MODE_STORAGE_KEY = "leo-workspace-mode";

interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolveWorkspaceMode(
  urlMode: string | null,
  storage: ModeStorage | null,
): WorkspaceMode {
  if (urlMode === "server") return "server";
  // `local-recovery` 是旧版「本地恢复」链接,现在等同于本机工作台。
  if (urlMode === "local" || urlMode === "local-recovery") return "local";
  try {
    return storage?.getItem(WORKSPACE_MODE_STORAGE_KEY) === "server" ? "server" : "local";
  } catch {
    return "local";
  }
}

/** 记住选择并返回切换后应加载的地址(去掉显式覆盖参数)。 */
export function prepareWorkspaceModeSwitch(
  mode: WorkspaceMode,
  currentHref: string,
  storage: ModeStorage | null,
): string {
  let persisted = false;
  try {
    storage?.setItem(WORKSPACE_MODE_STORAGE_KEY, mode);
    persisted = storage !== null;
  } catch {
    // 存储不可用:这次靠 URL 参数切过去,下次启动回到默认的本机工作台。
  }
  const target = new URL(currentHref);
  target.searchParams.delete("workspaceMode");
  if (mode === "server" && !persisted) target.searchParams.set("workspaceMode", "server");
  return target.href;
}
