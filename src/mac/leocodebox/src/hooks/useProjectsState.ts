import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../utils/apiClient';
import type { ServerEvent } from '../contexts/WebSocketContext';
import type {
  AppTab,
  Project,
  ProjectSession,
} from '../types/app';

import {
  countLoadedProjectSessions,
  getProjectSessions,
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  mergeTaskMasterCache,
  normalizeSessionProvider,
  persistLastSessionId,
  projectFromRegistration,
  projectsHaveChanges,
  readLastSessionId,
  readPersistedTab,
  readSelectedProvider,
  removeSessionFromProject,
  serialize,
  upsertSessionIntoProject,
  type FetchProjectsOptions,
  type ProjectSessionPage,
  type RegisterOptimisticSessionArgs,
  type SessionUpsertedEvent,
} from './projectStateUtils';
import type { SessionActivityMap } from './useSessionProtection';
import { createPendingPromptSlot } from './pendingPrompt';
import { useProjectRealtimeEvents } from './useProjectRealtimeEvents';
import { useProjectSessionAttention } from './useProjectSessionAttention';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  /** Subscription to the unified websocket event stream. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isMobile: boolean;
  activeSessions: SessionActivityMap;
};

/**
 * Shape of the per-session sidebar delta broadcast by the backend file
 * watcher (`kind: session_upserted`). It carries everything needed to upsert
 * one session row in place — no full project-list snapshot is ever pushed.
 */
export function useProjectsState({
  sessionId,
  navigate,
  subscribe,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);
  /**
   * 新会话的「第一句话」,和 `newSessionTrigger` **同一批**设置。
   *
   * 这是本次修复的核心:以前指挥条/主控台是「先 handleNewSession,再同步派发
   * 一个全局事件把草稿灌进 composer」—— 两条独立的异步流,没有共同的真源。
   * 主控台按下时 ChatInterface 还没挂载,事件没人听见;听见了草稿也落在会被
   * 新会话 reset 冲掉的 ref 里。于是内容凭空消失,人还被丢在"再选一次 Agent"
   * 的空态页上。把首句挂进新会话状态之后,它和重置信号一起到达,谁先谁后都不影响。
   *
   * `pendingPrompt` 是给渲染层看的(空态页据此不再出现),真值在 slot 里 ——
   * 消费必须同步且只有一次,详见 pendingPrompt.ts。
   */
  const pendingPromptSlot = useRef(createPendingPromptSlot()).current;
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const pendingRootSelectionReset = useRef(false);

  const consumePendingPrompt = useCallback(() => {
    const prompt = pendingPromptSlot.consume();
    if (prompt !== null) {
      setPendingPrompt(null);
    }
    return prompt;
  }, [pendingPromptSlot]);

  const { attentionSessionIds, markSessionAttention, clearSessionAttention } = useProjectSessionAttention(
    selectedSession,
    sessionId,
  );


  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const projectData = await apiClient.get<Project[]>('/api/projects');
      if (!Array.isArray(projectData)) {
        throw new Error(t('errorBoundary.invalidProjects'));
      }
      setProjectsError(null);

      setProjects((prevProjects) => {
        const projectsWithTaskMaster = mergeTaskMasterCache(projectData, prevProjects);
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectsWithTaskMaster);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
      setProjectsError(error instanceof Error ? error.message : t('errorBoundary.projectsLoadFallback'));
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, [t]);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const registerOptimisticSession = useCallback(({
    sessionId: newSessionId,
    provider,
    project,
    summary,
  }: RegisterOptimisticSessionArgs) => {
    if (!newSessionId || !project?.projectId) {
      return;
    }

    const now = new Date().toISOString();
    const optimisticSession: ProjectSession = {
      id: newSessionId,
      summary: summary ?? '',
      messageCount: 0,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      __provider: provider,
      __projectId: project.projectId,
    };
    const upsert: SessionUpsertedEvent = {
      kind: 'session_upserted',
      sessionId: newSessionId,
      provider,
      session: optimisticSession,
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
      },
      timestamp: now,
    };

    setProjects((previousProjects) => {
      const existingProject = previousProjects.find((candidate) => candidate.projectId === project.projectId);
      if (!existingProject) {
        return [upsertSessionIntoProject(projectFromRegistration(project), upsert), ...previousProjects];
      }

      const updatedProject = upsertSessionIntoProject(existingProject, upsert);
      if (updatedProject === existingProject) {
        return previousProjects;
      }

      return previousProjects.map((candidate) =>
        candidate.projectId === existingProject.projectId ? updatedProject : candidate,
      );
    });

    setSelectedProject((previousProject) => {
      if (!previousProject || previousProject.projectId !== project.projectId) {
        return previousProject;
      }

      const updatedProject = upsertSessionIntoProject(previousProject, upsert);
      return updatedProject === previousProject ? previousProject : updatedProject;
    });

    setSelectedSession((previousSession) => (
      previousSession?.id === newSessionId
        ? { ...previousSession, ...optimisticSession }
        : optimisticSession
    ));
  }, []);

  // Hydrates TaskMaster details for the given `projectId`. The project
  // identifier comes directly from the DB-driven /api/projects response.
  const hydrateProjectTaskMaster = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    try {
      const data = await apiClient.get<{ taskmaster?: Project['taskmaster'] }>(
        `/api/projects/${encodeURIComponent(projectId)}/taskmaster`,
      );
      const taskMasterInfo = data.taskmaster;
      if (!taskMasterInfo) {
        return;
      }

      setProjects((previousProjects) =>
        previousProjects.map((project) =>
          project.projectId === projectId
            ? { ...project, taskmaster: taskMasterInfo }
            : project,
        ),
      );

      setSelectedProject((previousProject) => {
        if (!previousProject || previousProject.projectId !== projectId) {
          return previousProject;
        }

        return {
          ...previousProject,
          taskmaster: taskMasterInfo,
        };
      });
    } catch (error) {
      console.error(`Error fetching TaskMaster info for project ${projectId}:`, error);
    }
  }, []);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!selectedProject?.projectId) {
      return;
    }

    void hydrateProjectTaskMaster(selectedProject.projectId);
  }, [hydrateProjectTaskMaster, selectedProject?.projectId]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // 原地站回: reopen the last visited session on boot. Only fires once, and
  // only when the app was opened at `/` (a deep link keeps its own session).
  const sessionRestoreAttempted = useRef(false);
  const restoredSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (sessionRestoreAttempted.current) return;
    sessionRestoreAttempted.current = true;
    if (sessionId) return;
    const lastSessionId = readLastSessionId();
    if (lastSessionId) {
      restoredSessionId.current = lastSessionId;
      navigate(`/session/${lastSessionId}`, { replace: true });
    }
  }, [sessionId, navigate]);

  // Remember every session the user lands on so the next boot returns there.
  useEffect(() => {
    if (sessionId) persistLastSessionId(sessionId);
  }, [sessionId]);

  // If the restored session no longer exists (deleted since last run), fall
  // back to the normal landing state instead of an empty phantom session.
  useEffect(() => {
    const restored = restoredSessionId.current;
    if (!restored || isLoadingProjects || projects.length === 0) return;
    if (sessionId !== restored) {
      restoredSessionId.current = null;
      return;
    }
    const stillExists = projects.some((project) =>
      project.sessions?.some((session) => session.id === restored));
    restoredSessionId.current = null;
    if (!stillExists) {
      persistLastSessionId(null);
      navigate('/', { replace: true });
    }
  }, [isLoadingProjects, projects, sessionId, navigate]);

  const { loadingProgress, externalMessageUpdate } = useProjectRealtimeEvents({
    subscribe,
    navigate,
    sessionId,
    activeSessions,
    selectedSession,
    setProjects,
    setSelectedProject,
    setSelectedSession,
    markSessionAttention,
  });


  useEffect(() => {
    clearSessionAttention(selectedSession?.id ?? sessionId ?? null);
  }, [clearSessionAttention, selectedSession?.id, sessionId]);

  useEffect(() => {
    // A root navigation is the explicit boundary between an old session and a
    // fresh/project-level workspace. React may render once with the previous
    // route param after the click; do not let that stale param repopulate the
    // session we just cleared.
    if (pendingRootSelectionReset.current) {
      if (!sessionId) pendingRootSelectionReset.current = false;
      return;
    }
    if (!sessionId || projects.length === 0) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    for (const project of projects) {
      const match = project.sessions?.find((session) => session.id === sessionId);
      if (match) {
        const normalizedSession = normalizeSessionProvider(match);
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== normalizedSession.__provider;

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession(normalizedSession);
        }
        return;
      }
    }

    // Session id is in the URL but not yet present on any project payload
    // (normal for a brand-new conversation: the composer allocates the id and
    // navigates before the sidebar learns about the session via
    // `session_upserted`). Without a `selectedSession`, chat state clears
    // `currentSessionId` and the UI stops reading the session store even
    // though messages stream under this id — so synthesize a placeholder.
    if (selectedSession?.id === sessionId) {
      return;
    }

    // Only the currently selected project may host the placeholder. Guessing
    // another project (e.g. "first one with sessions") could bind the URL
    // session to the wrong project — better to wait until the owning project
    // arrives in a later `projects` payload and is matched by the loop above.
    if (!selectedProject) {
      return;
    }

    setSelectedSession({
      id: sessionId,
      __provider: readSelectedProvider(),
      __projectId: selectedProject.projectId,
      summary: '',
    });
  }, [sessionId, projects, selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      pendingRootSelectionReset.current = true;
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      clearSessionAttention(session.id);
      // 用户改主意去看别的会话了:那句还没发出去的首句就此作废,
      // 不能留着等下一次开新会话时冒出来。
      pendingPromptSlot.consume();
      setPendingPrompt(null);
      setSelectedSession(session);

      // 主控台/任务/浏览器都不是会话视图:选了会话就得真的看得见它,
      // 否则点了列表却停在原地,像是"没反应"。
      if (activeTab === 'tasks' || activeTab === 'browser' || activeTab === 'dashboard') {
        setActiveTab('chat');
      }

      if (isMobile) {
        // Sessions are tagged with the owning project's DB `projectId` when
        // picked from the sidebar (see useSidebarController); compare against
        // the current selection's `projectId` so we know whether to collapse
        // the sidebar after navigation.
        const sessionProjectId = session.__projectId;
        const currentProjectId = selectedProject?.projectId;

        if (sessionProjectId !== currentProjectId) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, clearSessionAttention, isMobile, navigate, pendingPromptSlot, selectedProject?.projectId],
  );

  /**
   * 开一个新会话。`initialPrompt` 非空时,它是这个新会话的第一条消息 ——
   * 和重置信号在同一批 setState 里下发,composer 一就绪就能读到它并发出去。
   * 不传(侧栏「新会话」、⌘K 换 Agent)则清空待发位,避免上一条串到这个会话。
   */
  const handleNewSession = useCallback(
    (project: Project, initialPrompt?: string) => {
      pendingRootSelectionReset.current = true;
      pendingPromptSlot.set(initialPrompt);
      setPendingPrompt(pendingPromptSlot.peek());
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate, pendingPromptSlot],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      clearSessionAttention(sessionIdToDelete);

      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => removeSessionFromProject(project, sessionIdToDelete)),
      );
    },
    [clearSessionAttention, navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const freshProjects = await apiClient.get<Project[]>('/api/projects');
      const projectsWithTaskMaster = mergeTaskMasterCache(freshProjects, projects);
      const mergedProjects = mergeExpandedSessionPages(projects, projectsWithTaskMaster);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects) ? mergedProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.projectId === selectedProject.projectId);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject, selectedSession]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const loadedCount = countLoadedProjectSessions(project);
    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (totalCount > 0 && loadedCount >= totalCount) {
      return;
    }

    const sessionsPage = await apiClient.get<ProjectSessionPage>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
      { limit: 20, offset: loadedCount },
    );

    let mergedProjectForSelection: Project | null = null;
    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        const mergedProject = mergeProjectSessionPage(candidate, sessionsPage);
        mergedProjectForSelection = mergedProject;
        return mergedProject;
      }),
    );

    if (selectedProject?.projectId === projectId && mergedProjectForSelection) {
      setSelectedProject(mergedProjectForSelection);
    }
  }, [projects, selectedProject?.projectId]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      if (selectedProject?.projectId === projectId) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [navigate, selectedProject?.projectId],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      activeSessions,
      attentionSessionIds,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      attentionSessionIds,
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      loadMoreProjectSessions,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      activeSessions,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    projectsError,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    newSessionTrigger,
    pendingPrompt,
    consumePendingPrompt,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
