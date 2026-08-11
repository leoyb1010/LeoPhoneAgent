import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';

import { apiClient } from '../../../utils/apiClient';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import type {
  ArchivedSessionListItem,
  DeleteProjectConfirmation,
  ProjectSortOrder,
  SidebarSearchMode,
  SessionDeleteConfirmation,
  SessionWithProvider,
} from '../types/types';
import {
  filterProjects,
  getAllSessions,
  readProjectSortOrder,
  sortProjects,
} from '../utils/utils';

import { useConversationSearch } from './useConversationSearch';
import { useProjectStarToggle } from './useProjectStarToggle';
import { useSidebarArchive } from './useSidebarArchive';

export type { ConversationSearchResults, SearchProgress } from './useConversationSearch';


type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeSessions: SessionActivityMap;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB-assigned identifier; callbacks use that post-migration.
  onProjectDelete?: (projectId: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession: _selectedSession,
  activeSessions,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const paletteOps = usePaletteOps();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteProjectConfirmation | null>(null);
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  const {
    conversationResults,
    isSearching,
    searchProgress,
    debouncedSearchQuery,
    clearConversationResults,
  } = useConversationSearch(searchFilter, searchMode);
  const {
    archivedProjects,
    archivedSessions,
    isArchivedSessionsLoading,
    fetchArchivedSessions,
  } = useSidebarArchive(searchMode);
  const { toggleStarProject, isProjectStarred, projectsWithResolvedStarState } = useProjectStarToggle({ projects, t, onRefresh });

  const isSidebarCollapsed = !isMobile && !sidebarVisible;
  const activeSessionIds = useMemo(() => new Set(activeSessions.keys()), [activeSessions]);
  const runningSessionsCount = activeSessionIds.size;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setInitialSessionsLoaded(new Set());
  }, [projects]);

  useEffect(() => {
    // Auto-expand only when the selected project identity changes.
    // Depending on the full `selectedProject` object (or `selectedSession`) causes
    // websocket-driven list refreshes to re-open projects users manually collapsed.
    const selectedProjectId = selectedProject?.projectId;
    if (!selectedProjectId) {
      return;
    }

    setExpandedProjects((prev) => {
      if (prev.has(selectedProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      const loadedProjects = new Set<string>();
      projects.forEach((project) => {
        if (project.sessions && project.sessions.length >= 0) {
          loadedProjects.add(project.projectId);
        }
      });
      setInitialSessionsLoaded(loadedProjects);
    }
  }, [projects, isLoading]);

  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        loadSortOrder();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set<string>();
      if (!prev.has(projectId)) {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectId: string) => {
      // Tag the session with its owning projectId so downstream handlers
      // can correlate it with the selectedProject in the app state.
      onSessionSelect({ ...session, __projectId: projectId });
    },
    [onSessionSelect],
  );


  const getProjectSessions = useCallback((project: Project) => getAllSessions(project), []);

  const loadMoreSessionsForProject = useCallback(async (projectId: string) => {
    if (!onLoadMoreSessions) {
      return;
    }

    let shouldLoad = false;
    setLoadingMoreProjects((previous) => {
      if (previous.has(projectId)) {
        return previous;
      }

      shouldLoad = true;
      const next = new Set(previous);
      next.add(projectId);
      return next;
    });

    if (!shouldLoad) {
      return;
    }

    try {
      await onLoadMoreSessions(projectId);
    } catch (error) {
      console.error('[Sidebar] Failed to load more sessions:', error);
      alert(t('messages.refreshError'));
    } finally {
      setLoadingMoreProjects((previous) => {
        const next = new Set(previous);
        next.delete(projectId);
        return next;
      });
    }
  }, [onLoadMoreSessions, t]);



  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  const runningProjects = useMemo(() => {
    if (activeSessionIds.size === 0) {
      return [];
    }

    return sortedProjects.reduce<Project[]>((acc, project) => {
      const sessions = (project.sessions ?? []).filter((session) => activeSessionIds.has(String(session.id)));
      const runningCount = sessions.length;

      if (runningCount === 0) {
        return acc;
      }

      acc.push({
        ...project,
        sessions,
        sessionMeta: {
          ...project.sessionMeta,
          total: runningCount,
          hasMore: false,
        },
      });
      return acc;
    }, []);
  }, [activeSessionIds, sortedProjects]);

  const filteredProjects = useMemo(
    () => filterProjects(searchMode === 'running' ? runningProjects : sortedProjects, debouncedSearchQuery),
    [debouncedSearchQuery, runningProjects, searchMode, sortedProjects],
  );

  const filteredArchivedSessions = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedSessions;
    }

    return archivedSessions.filter((session) => {
      const searchableFields = [
        session.sessionTitle,
        session.projectDisplayName,
        session.projectPath ?? '',
        session.provider,
      ];

      return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [archivedSessions, debouncedSearchQuery]);

  const filteredArchivedProjects = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedProjects;
    }

    return archivedProjects.filter((project) => {
      const projectMatches = [
        project.displayName,
        project.fullPath || '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch));

      if (projectMatches) {
        return true;
      }

      return getAllSessions(project).some((session) => {
        const sessionSummary =
          typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string'
              ? session.name
              : '';

        return [
          sessionSummary,
          session.__provider,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
    });
  }, [archivedProjects, debouncedSearchQuery]);

  const startEditing = useCallback((project: Project) => {
    // `editingProject` is keyed by projectId so it stays stable across
    // display-name mutations that happen while the input is open.
    setEditingProject(project.projectId);
    setEditingName(project.displayName);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProject(null);
    setEditingName('');
  }, []);

  const saveProjectName = useCallback(
    // `projectId` is the DB primary key; the rename API resolves the path
    // through the `projects` table before writing the new display name.
    async (projectId: string) => {
      try {
        await apiClient.put(`/api/projects/${encodeURIComponent(projectId)}/rename`, {
          displayName: editingName,
        });
        await paletteOps.refreshProjects();
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setEditingProject(null);
        setEditingName('');
      }
    },
    [editingName, paletteOps],
  );

  const showDeleteSessionConfirmation = useCallback(
    // Kept with project/provider arguments for component wiring compatibility;
    // deletion now uses only `sessionId` via /api/providers/sessions/:sessionId.
    (
      projectId: string | null,
      sessionId: string,
      sessionTitle: string,
      provider: SessionDeleteConfirmation['provider'] = 'claude',
      options: {
        isArchived?: boolean;
      } = {},
    ) => {
      setSessionDeleteConfirmation({
        projectId,
        sessionId,
        sessionTitle,
        provider,
        isArchived: Boolean(options.isArchived),
      });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async (hardDelete = false) => {
    if (!sessionDeleteConfirmation) {
      return;
    }

    const { sessionId } = sessionDeleteConfirmation;
    setSessionDeleteConfirmation(null);

    try {
      await apiClient.deleteQuery(
        `/api/providers/sessions/${encodeURIComponent(sessionId)}`,
        hardDelete ? { force: true } : undefined,
      );
      onSessionDelete?.(sessionId);
      await fetchArchivedSessions();
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [fetchArchivedSessions, onSessionDelete, sessionDeleteConfirmation, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setDeleteConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async (deleteData = false) => {
    if (!deleteConfirmation) {
      return;
    }

    const { project } = deleteConfirmation;

    setDeleteConfirmation(null);
    // Track in-flight deletes by projectId so the UI can disable actions
    // even if the project object is rebuilt while the request is flying.
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      await apiClient.deleteQuery(
        `/api/projects/${encodeURIComponent(project.projectId)}`,
        deleteData ? { force: true } : undefined,
      );
      onProjectDelete?.(project.projectId);
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [deleteConfirmation, onProjectDelete, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  const openArchivedSession = useCallback((session: ArchivedSessionListItem) => {
    const activeProject = session.projectId
      ? projects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const archivedProject = session.projectId
      ? archivedProjects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const matchingProject = activeProject ?? archivedProject ?? null;
    const sessionPayload: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      __provider: session.provider,
      __projectId: matchingProject?.projectId ?? session.projectId ?? undefined,
    };

    // Archived sessions still need a selected project context. Active projects
    // come from the normal sidebar list, while archived-project sessions resolve
    // through the archive payload loaded by this controller.
    if (matchingProject) {
      handleProjectSelect(matchingProject);
    }

    onSessionSelect(sessionPayload);
  }, [archivedProjects, handleProjectSelect, onSessionSelect, projects]);

  const restoreArchivedProject = useCallback(async (projectId: string) => {
    try {
      await apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/restore`);

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError', 'Error restoring project. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      await apiClient.post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/restore`);

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchArchivedSessions, onRefresh]);

  const updateSessionSummary = useCallback(
    // `_projectId` and `_provider` are preserved for compatibility with
    // existing sidebar callback signatures; backend rename only needs sessionId.
    async (_projectId: string, sessionId: string, summary: string, _provider: LLMProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }
      try {
        await apiClient.put(`/api/providers/sessions/${encodeURIComponent(sessionId)}`, {
          summary: trimmed,
        });
        await onRefresh();
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setEditingSession(null);
        setEditingSessionName('');
      }
    },
    [onRefresh, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    projectSortOrder,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    deletingProjects,
    loadingMoreProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    runningSessionsCount,
    archivedProjects: filteredArchivedProjects,
    archivedSessions: filteredArchivedSessions,
    archivedSessionsCount: archivedProjects.length + archivedSessions.length,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  };
}
