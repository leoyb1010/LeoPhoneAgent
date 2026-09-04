import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { apiClient } from '../../../utils/apiClient';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import type { LLMProvider, Project } from '../../../types/app';
import type { OpenMissionSession } from '../../missions/view/MissionsView';
import FleetView from '../../fleet/view/FleetView';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import WorkspaceActivityStrip from './subcomponents/WorkspaceActivityStrip';
import WorkspaceRunInspector from './subcomponents/WorkspaceRunInspector';

const ChatInterface = React.lazy(() => import('../../chat/view/ChatInterface'));
const FileTree = React.lazy(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = React.lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const GitPanel = React.lazy(() => import('../../git-panel/view/GitPanel'));
const PluginTabContent = React.lazy(() => import('../../plugins/view/PluginTabContent'));
const BrowserUsePanel = React.lazy(() => import('../../browser-use/view/BrowserUsePanel'));
const ConversationAuditPanel = React.lazy(() => import('../../conversation-audit/view/ConversationAuditPanel'));
const MissionsView = React.lazy(() => import('../../missions/view/MissionsView'));
const TaskStartView = React.lazy(() => import('../../task-start/TaskStartView'));
const EditorSidebar = React.lazy(() => import('../../code-editor/view/EditorSidebar'));
const TaskMasterPanel = React.lazy(() => import('../../task-master/view/TaskMasterPanel'));

function PanelFallback() {
  const { t } = useTranslation();
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('workspaceRuntime.loadingWorkspace')}</div>;
}

const panelFallback = <PanelFallback />;

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  pendingPrompt,
  consumePendingPrompt,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  // Bridge from the mission board (L4) into the chat session that a card runs
  // in. On "开工" we also send the card goal as the first prompt so the agent
  // actually starts working; the "打开会话" button reuses the same jump without
  // re-sending. Optimistically register the session so it appears in the
  // sidebar with the correct provider before the next projects refresh.
  const handleOpenMissionSession = useCallback<OpenMissionSession>(
    ({ sessionId, goal, provider, sendGoal }) => {
      if (selectedProject) {
        onSessionEstablished(sessionId, { provider: provider as LLMProvider, project: selectedProject, summary: goal });
      }
      setActiveTab('chat');
      onNavigateToSession(sessionId);
      if (sendGoal) {
        sendMessage({ type: 'chat.send', sessionId, content: goal, options: {} });
      }
    },
    [onSessionEstablished, selectedProject, setActiveTab, onNavigateToSession, sendMessage],
  );

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const data = await apiClient.get<{ success?: boolean; data?: { settings?: { enabled?: boolean } } }>(
        '/api/browser-use/settings',
      );
      setBrowserUseEnabled(Boolean(data.success !== false && data.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  // `dashboard` 只保留为旧本地状态的内部兼容值；可见界面已经收敛成“新任务”。
  // 这里不再加载指标、模块卡或第二个输入框，唯一提交入口是外壳 Task Dock。
  // 移动端例外:那里没有指挥条/会话列表,选项目全靠抽屉的汉堡按钮,所以保留
  // 带菜单入口的空态,否则没项目的手机会被困在一个开不了抽屉的页面上。
  // fleet / missions 不绑项目也能用，不能被无项目状态吞回新任务页。
  if (activeTab === 'fleet') {
    return (
      <div className="leocodebox-workspace-enter h-full overflow-hidden">
        <ErrorBoundary showDetails>
          <FleetView />
        </ErrorBoundary>
      </div>
    );
  }

  if (activeTab === 'dashboard' || (!isLoading && !selectedProject && !isMobile && activeTab !== 'missions')) {
    return (
      <div className="leocodebox-workspace-enter h-full overflow-hidden">
        <ErrorBoundary showDetails>
          <React.Suspense fallback={panelFallback}>
            <TaskStartView project={selectedProject} />
          </React.Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const selectedActivity = selectedSession
    ? processingSessions.get(selectedSession.id) ?? null
    : null;

  return (
    <div className="leocodebox-workspace-enter flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <WorkspaceActivityStrip session={selectedSession} activity={selectedActivity} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`workspace-tab-panel h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`} data-active={activeTab === 'chat'}>
            <ErrorBoundary showDetails resetKeys={[selectedSession?.id, selectedProject?.projectId]}>
              <React.Suspense fallback={panelFallback}>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                pendingPrompt={pendingPrompt}
                consumePendingPrompt={consumePendingPrompt}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
              </React.Suspense>
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="workspace-tab-panel h-full w-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  showHeader={false}
                  isActive={activeTab === 'shell'}
                />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'missions' && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <MissionsView selectedProject={selectedProject} onOpenMissionSession={handleOpenMissionSession} />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {shouldShowTasksTab && (
            <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
              <TaskMasterPanel isVisible={activeTab === 'tasks'} />
              </React.Suspense>
            </ErrorBoundary>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
                <React.Suspense fallback={panelFallback}>
                  <ConversationAuditPanel />
                </React.Suspense>
              </ErrorBoundary>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="workspace-tab-panel h-full overflow-hidden" data-active="true">
              <ErrorBoundary showDetails>
              <React.Suspense fallback={panelFallback}>
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
              </React.Suspense>
              </ErrorBoundary>
            </div>
          )}
        </div>

        {editingFile && <ErrorBoundary showDetails>
          <React.Suspense fallback={panelFallback}>
          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            projectPath={selectedProject.path}
            fillSpace={activeTab === 'files'}
          />
          </React.Suspense>
        </ErrorBoundary>}
        {activeTab === 'chat' && !editingFile && selectedActivity && (
          <WorkspaceRunInspector
            project={selectedProject}
            session={selectedSession}
            activity={selectedActivity}
            runningCount={processingSessions.size}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
