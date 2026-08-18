import type { ServerEvent } from '../contexts/WebSocketContext';
import type { AppTab, LLMProvider, Project, ProjectSession } from '../types/app';

import { incrementProjectProviderCount } from './projectProviderCounts';

export type SessionUpsertedEvent = ServerEvent & {
  sessionId: string;
  providerSessionId?: string | null;
  provider: LLMProvider;
  session: ProjectSession;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
  } | null;
};

export type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

export type RegisterOptimisticSessionArgs = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

export type ProjectSessionPage = Pick<Project, 'sessions' | 'sessionMeta'>;

const DEFAULT_PROVIDER: LLMProvider = 'codex';

export const serialize = (value: unknown) => JSON.stringify(value ?? null);

export const readSelectedProvider = (): LLMProvider => {
  try {
    const storedProvider = localStorage.getItem('selected-provider');
    return storedProvider ? storedProvider as LLMProvider : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : DEFAULT_PROVIDER;
};

export const normalizeSessionProvider = (session: ProjectSession): ProjectSession => ({
  ...session,
  __provider: getSessionProvider(session),
});

export const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster)
    );
  });
};

export const mergeTaskMasterCache = (nextProjects: Project[], previousProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return nextProjects;
  }

  // Keyed by `projectId` (the DB primary key) so caches stay correct across
  // renames and other mutations that might have changed the display name.
  const previousTaskMasterByProject = new Map(
    previousProjects
      .filter((project) => Boolean(project.taskmaster))
      .map((project) => [project.projectId, project.taskmaster]),
  );

  return nextProjects.map((project) => {
    const cachedTaskMasterInfo = previousTaskMasterByProject.get(project.projectId);
    if (!cachedTaskMasterInfo) {
      return project;
    }

    return {
      ...project,
      taskmaster: cachedTaskMasterInfo,
    };
  });
};

export const getProjectSessions = (project: Project): ProjectSession[] => {
  return project.sessions ?? [];
};

export const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

export const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], previousProject.sessions ?? []),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

export const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: ProjectSessionPage,
): Project => {
  const mergedProject: Project = {
    ...existingProject,
    sessions: mergeSessionProviderLists(existingProject.sessions ?? [], sessionsPage.sessions ?? []),
  };

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

const getSessionAliasIds = (event: SessionUpsertedEvent): Set<string> => {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  };

  add(event.sessionId);
  add(event.providerSessionId);
  add(event.session?.id);

  return ids;
};

/**
 * Upserts one session into a project's normalized session list.
 *
 * Existing rows are updated in place (summary/lastActivity changes from the
 * watcher); new rows are prepended since the watcher only fires for sessions
 * with fresh activity. `sessionMeta.total` grows only on insert.
 */
export const upsertSessionIntoProject = (project: Project, event: SessionUpsertedEvent): Project => {
  const sessions = project.sessions ?? [];
  const aliasIds = getSessionAliasIds(event);
  const normalizedSession: ProjectSession = {
    ...event.session,
    id: event.sessionId,
    __provider: event.provider,
  };
  const existingIndex = sessions.findIndex((session) => aliasIds.has(String(session.id)));

  let nextSessions: ProjectSession[];
  let inserted = false;
  if (existingIndex >= 0) {
    let changed = false;
    nextSessions = [];

    for (const [index, session] of sessions.entries()) {
      if (index === existingIndex) {
        const updated = { ...session, ...normalizedSession };
        // Never let a later upsert that carries an empty summary blank out a
        // title we already have. Fresh sessions momentarily broadcast an empty
        // custom_name before the disk indexer fills it in, which would
        // otherwise flash the row back to the "New session" placeholder.
        if (!normalizedSession.summary?.trim() && session.summary?.trim()) {
          updated.summary = session.summary;
        }
        if (serialize(session) !== serialize(updated)) {
          changed = true;
        }
        nextSessions.push(updated);
        continue;
      }

      if (aliasIds.has(String(session.id))) {
        changed = true;
        continue;
      }

      nextSessions.push(session);
    }

    if (!changed) {
      return project;
    }
  } else {
    nextSessions = [normalizedSession, ...sessions];
    inserted = true;
  }

  const next: Project = { ...project, sessions: nextSessions };
  if (inserted) {
    const total = Number(project.sessionMeta?.total ?? 0) + 1;
    next.sessionMeta = {
      ...project.sessionMeta,
      total,
      hasMore: countLoadedProjectSessions(next) < total,
    };
    next.providerCounts = incrementProjectProviderCount(project.providerCounts, event.provider);
  }

  return next;
};

export const projectFromRegistration = (project: Project): Project => ({
  projectId: project.projectId,
  path: project.path || project.fullPath,
  fullPath: project.fullPath || project.path || '',
  displayName: project.displayName,
  isStarred: project.isStarred,
  sessions: project.sessions ?? [],
  sessionMeta: project.sessionMeta ?? { hasMore: false, total: countLoadedProjectSessions(project) },
  taskmaster: project.taskmaster,
});

export const removeSessionFromProject = (project: Project, sessionIdToDelete: string): Project => {
  const sessions = project.sessions ?? [];
  const nextSessions = sessions.filter((session) => session.id !== sessionIdToDelete);
  if (nextSessions.length === sessions.length) {
    return project;
  }

  const updatedProject: Project = {
    ...project,
    sessions: nextSessions,
  };

  const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
  updatedProject.sessionMeta = {
    ...project.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
  };

  return updatedProject;
};

const VALID_TABS: Set<string> = new Set(['chat', 'files', 'shell', 'git', 'tasks', 'browser']);

/**
 * Tabs that the 工作台 shell retired. `dashboard` and `fleet` stopped being
 * pages (the dashboard's numbers moved into Leoapi/关于, the fleet into the
 * titlebar capsule) and `missions` moved into ⌘K. They are still listed here
 * so an existing install whose `activeTab` points at one of them lands on the
 * conversation instead of a blank workspace.
 */
const RETIRED_TABS: Set<string> = new Set(['dashboard', 'fleet', 'missions']);

export const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

export const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && RETIRED_TABS.has(stored)) {
      localStorage.removeItem('activeTab');
      return 'chat';
    }
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  // 对话即首页:工作台冷启动直接进会话,不再落在仪表盘。
  return 'chat';
};

const LAST_SESSION_KEY = 'last-session-id';

export const readLastSessionId = (): string | null => {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
};

export const persistLastSessionId = (sessionId: string | null): void => {
  try {
    if (sessionId) {
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
    } else {
      localStorage.removeItem(LAST_SESSION_KEY);
    }
  } catch {
    // localStorage unavailable
  }
};

const HANDOFF_SOURCE_KEY = 'handoff-source-map';

const readHandoffSourceMap = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(HANDOFF_SOURCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
};

/** The session a handed-off session was created from, for the ⌘K return ticket. */
export const readHandoffSource = (sessionId: string): string | null => {
  if (!sessionId) return null;
  const source = readHandoffSourceMap()[sessionId];
  return typeof source === 'string' && source ? source : null;
};

export const persistHandoffSource = (newSessionId: string, sourceSessionId: string | null): void => {
  if (!newSessionId) return;
  try {
    const map = readHandoffSourceMap();
    if (sourceSessionId) {
      map[newSessionId] = sourceSessionId;
    } else {
      delete map[newSessionId];
    }
    localStorage.setItem(HANDOFF_SOURCE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable
  }
};
