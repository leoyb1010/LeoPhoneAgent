// 生产代码已不再注册远程 workspace session（SSH / WSL / Docker 远程工作区已删除），
// remoteWorkspaceSessionStore 只剩只读解析。这里仅为路由层的只读分支测试直接写入 store 状态。
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "../../src/store/remoteWorkspaceSessionStore.js";

export function registerRemoteWorkspaceSession(session: RemoteWorkspaceSession): void {
  useRemoteWorkspaceSessionStore.setState((state) => ({
    sessionsById: { ...state.sessionsById, [session.sessionId]: session },
  }));
}

export function unregisterRemoteWorkspaceSession(sessionId: string): void {
  useRemoteWorkspaceSessionStore.setState((state) => {
    const sessionsById = { ...state.sessionsById };
    delete sessionsById[sessionId];
    const keep = ([, id]: [string, string]) => id !== sessionId;
    return {
      sessionsById,
      sessionIdByWorkspacePath: Object.fromEntries(
        Object.entries(state.sessionIdByWorkspacePath).filter(keep),
      ),
      sessionIdByWorkspaceIdentity: Object.fromEntries(
        Object.entries(state.sessionIdByWorkspaceIdentity).filter(keep),
      ),
    };
  });
}

export function bindRemoteWorkspacePath(workspacePath: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.setState((state) => ({
    sessionIdByWorkspacePath: { ...state.sessionIdByWorkspacePath, [workspacePath]: sessionId },
  }));
}

export function bindRemoteWorkspaceIdentity(workspaceIdentity: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.setState((state) => ({
    sessionIdByWorkspaceIdentity: {
      ...state.sessionIdByWorkspaceIdentity,
      [workspaceIdentity]: sessionId,
    },
  }));
}
