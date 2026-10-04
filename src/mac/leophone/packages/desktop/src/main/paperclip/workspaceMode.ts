/** 默认只连接服务器；本地 Host 必须由用户明确进入历史恢复模式后启动。 */
export function requestsLocalRecovery(rendererUrl: string): boolean {
  try {
    return new URL(rendererUrl).searchParams.get("workspaceMode") === "local-recovery";
  } catch {
    return false;
  }
}
