import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSidebarController } from '../hooks/useSidebarController';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import type { Project, LLMProvider } from '../../../types/app';
import type { MCPServerStatus, SidebarProps } from '../types/types';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  activeSessions,
  attentionSessionIds,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { updateAvailable, restartRequired, latestVersion, currentVersion, releaseInfo } = useVersionCheck();
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMaster() as TaskMasterSidebarContext;
  const { tasksEnabled } = useTasksSettings();
  const paletteOps = usePaletteOps();
  const [localTool, setLocalTool] = useState<'leoapi' | 'feedback' | null>(null);
  const closeLocalTool = useCallback(() => setLocalTool(null), []);

  useEffect(() => {
    const unsubscribe = window.leocodeboxDesktopTools?.onOpenModal((tool) => {
      if (tool === 'leoapi' || tool === 'feedback') setLocalTool(tool);
    });
    const handleLocalTool = (event: Event) => {
      const tool = (event as CustomEvent<'leoapi' | 'feedback'>).detail;
      if (tool === 'leoapi' || tool === 'feedback') setLocalTool(tool);
    };
    window.addEventListener('leocodebox:open-local-tool', handleLocalTool);
    return () => {
      unsubscribe?.();
      window.removeEventListener('leocodebox:open-local-tool', handleLocalTool);
    };
  }, []);

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    runningSessionsCount,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadingMoreProjects,
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
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
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
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  // The status-bar update dot lives in a sibling component; it asks the sidebar
  // (owner of the version modal) to open the update card via a window event.
  useEffect(() => {
    const openVersionModal = () => setShowVersionModal(true);
    window.addEventListener('leocodebox:open-version-modal', openVersionModal);
    return () => window.removeEventListener('leocodebox:open-version-modal', openVersionModal);
  }, [setShowVersionModal]);

  const handleProjectCreated = () => {
    void paletteOps.refreshProjects();
  };

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    editingProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    loadingMoreProjects,
    activeSessions,
    attentionSessionIds,
    forceExpanded: searchMode === 'running',
    isProjectStarred,
    onOpenAgentSettings: onShowSettings,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (projectName) => {
      void saveProjectName(projectName);
    },
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        t={t}
        localTool={localTool}
        onCloseLocalTool={closeLocalTool}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          onShowVersionModal={() => setShowVersionModal(true)}
          t={t}
          onShowLeoapi={() => setLocalTool('leoapi')}
          onShowFeedback={() => setLocalTool('feedback')}
        />
      ) : (
        <>
        <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            runningSessionsCount={runningSessionsCount}
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            searchMode={searchMode}
            onSearchModeChange={(mode) => {
              setSearchMode(mode);
              if (mode === 'projects') clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onRestoreArchivedProject={restoreArchivedProject}
            onArchivedSessionClick={openArchivedSession}
            onRestoreArchivedSession={restoreArchivedSession}
            onDeleteArchivedSession={(session) => {
              showDeleteSessionConfirmation(
                session.projectId,
                session.sessionId,
                session.sessionTitle,
                session.provider,
                { isArchived: true },
              );
            }}
            onConversationResultClick={(projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
              // `projectId` (DB key) is the canonical identifier post-migration.
              // The server emits null when it can't resolve a project row for
              // the search hit; treat that as "no project" and still navigate
              // to the session so the user can open it from the URL.
              const resolvedProvider = (provider || 'claude') as LLMProvider;
              const project = projectId ? projects.find(p => p.projectId === projectId) : null;
              const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
              const sessionObj = {
                id: sessionId,
                __provider: resolvedProvider,
                __projectId: projectId ?? undefined,
                ...searchTarget,
              };
              if (project) {
                handleProjectSelect(project);
                const sessions = getProjectSessions(project);
                const existing = sessions.find(s => s.id === sessionId);
                if (existing) {
                  handleSessionClick({ ...existing, ...searchTarget }, project.projectId);
                } else {
                  handleSessionClick(sessionObj, project.projectId);
                }
              } else {
                handleSessionClick(sessionObj, projectId ?? '');
              }
            }}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            onCreateProject={() => setShowNewProject(true)}
            onCollapseSidebar={handleCollapseSidebar}
            updateAvailable={updateAvailable}
            restartRequired={restartRequired}
            releaseInfo={releaseInfo}
            latestVersion={latestVersion}
            currentVersion={currentVersion}
            onShowVersionModal={() => setShowVersionModal(true)}
            onShowSettings={onShowSettings}
            onShowLeoapi={() => setLocalTool('leoapi')}
            onShowFeedback={() => setLocalTool('feedback')}
            projectListProps={projectListProps}
            t={t}
          />
        </>
      )}

    </>
  );
}

// Props flow from `useProjectsState` (sidebarSharedProps is a memoized object,
// its callbacks are stable useCallbacks), so a shallow-equal memo lets the
// sidebar skip re-renders driven purely by unrelated app state (e.g. streaming).
export default memo(Sidebar);
