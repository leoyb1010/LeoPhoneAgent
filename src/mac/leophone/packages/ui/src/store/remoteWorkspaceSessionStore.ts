import { create } from "zustand";
import type { RemoteTarget } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

export interface RemoteWorkspaceSession {
  sessionId: string;
  target?: RemoteTarget;
  services: IServiceAccessor;
  dispose?: (reason?: Error) => void;
}

// LeoBot 已删除 SSH / WSL / Docker 远程工作区：不再有任何入口注册远程 session，
// sessionsById / sessionIdBy* 恒为空，只保留给 workspace 路由层的只读解析
// （带远程身份的目标继续 fail-closed，而不是误落到本机 host）。
interface RemoteWorkspaceSessionState {
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspacePath: Record<string, string>;
  sessionIdByWorkspaceIdentity: Record<string, string>;
  registerBaseServices: (services: IServiceAccessor) => void;
}

export const useRemoteWorkspaceSessionStore = create<RemoteWorkspaceSessionState>()((set) => ({
  baseServices: null,
  sessionsById: {},
  sessionIdByWorkspacePath: {},
  sessionIdByWorkspaceIdentity: {},
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
}));

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
}

export function getRemoteWorkspaceSession(sessionId: string): RemoteWorkspaceSession | null {
  return useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId] ?? null;
}

/** 当前在册代理的远程 session 身份；旧代代理不匹配，仅用于 scope 诊断。 */
export function findRemoteWorkspaceSessionIdForAgentService(agentService: object): string | null {
  for (const session of Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    if (session.services.zcodeAgentService === agentService) {
      return session.sessionId;
    }
  }
  return null;
}

export function getRemoteWorkspaceServicesForPath(workspacePath: string): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspacePath[workspacePath];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRemoteWorkspaceServicesForIdentity(
  workspaceIdentity: string,
): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspaceIdentity[workspaceIdentity];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRegisteredBaseWorkspaceServices(): IServiceAccessor | null {
  return useRemoteWorkspaceSessionStore.getState().baseServices;
}

export function resolveRegisteredWorkspaceServices(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
}): IServiceAccessor | null {
  if (params.workspaceIdentity?.trim()) {
    return (
      getRemoteWorkspaceServicesForIdentity(params.workspaceIdentity) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  if (params.workspacePath?.trim()) {
    return (
      getRemoteWorkspaceServicesForPath(params.workspacePath) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  return getRegisteredBaseWorkspaceServices();
}
