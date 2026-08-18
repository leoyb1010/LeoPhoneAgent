import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import MainContent from '../main-content/view/MainContent';
import SettingsHost from '../settings/view/SettingsHost';
import CommandPalette from '../command-palette/CommandPalette';
import LocalToolModal from '../sidebar/view/subcomponents/LocalToolModal';
import WorkbenchTitleBar from '../workbench/WorkbenchTitleBar';
import CommandBar from '../workbench/CommandBar';
import SessionRail from '../workbench/SessionRail';
import LeoapiPanel from '../workbench/LeoapiPanel';
import ProjectDrawer from '../workbench/ProjectDrawer';
import RemoteSessionPanel, { type RemoteTarget } from '../workbench/RemoteSessionPanel';
import { useFleetSnapshot, type FleetMachine } from '../workbench/useFleetSnapshot';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../chat/types/types';
import type { Project, ProjectSession } from '../../types/app';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';
import { withViewTransition } from '../../utils/viewTransition';

import WorkspaceStatusBar from './WorkspaceStatusBar';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const navigateWithTransition = useCallback<NavigateFunction>((to: To | number, options?: NavigateOptions) => {
    withViewTransition(() => navigate(to as To, options));
  }, [navigate]);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    isLoadingProjects,
    projectsError,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
    handleSessionSelect,
    fetchProjects,
  } = useProjectsState({
    sessionId,
    navigate: navigateWithTransition,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });
  const runningSessionFailures = useRef(0);

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const payload = await apiClient.get<RunningSessionsApiPayload>(
        '/api/providers/sessions/running',
      );
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      runningSessionFailures.current = 0;

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
      runningSessionFailures.current += 1;
      if (runningSessionFailures.current >= 2) syncProcessingSessions([]);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    return startVisibleInterval(() => {
      void refreshRunningSessions();
    }, 15_000);
  }, [refreshRunningSessions]);

  // Mirror the running count onto the macOS Dock badge so a long task can be
  // watched from outside the app.
  useEffect(() => {
    void window.leocodeboxDesktopTools?.setRunningBadge?.(processingSessions.size);
  }, [processingSessions.size]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => window.leocodeboxDesktopTools?.onOpenModal((tool) => {
    if (tool === 'settings') openSettings();
  }), [openSettings]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigateWithTransition(`/session/${message.sessionId}`);
        return;
      }

      navigateWithTransition('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigateWithTransition, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  // Launching an agent profile (from Settings) fires this event; the profile's
  // provider/model/effort/permission were already applied via the preferences
  // event, so here we just open a fresh conversation in the current project.
  useEffect(() => {
    const onLaunchNewChat = () => {
      if (selectedProject) handleNewSession(selectedProject);
    };
    window.addEventListener('leocodebox:launch-new-chat', onLaunchNewChat);
    return () => window.removeEventListener('leocodebox:launch-new-chat', onLaunchNewChat);
  }, [handleNewSession, selectedProject]);

  // Stable identities so MainContent's React.memo isn't defeated by fresh inline
  // closures on every AppContent re-render.
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);

  const handleNavigateToSession = useCallback(
    (targetSessionId: string, options?: SessionNavigationOptions) =>
      navigateWithTransition(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) }),
    [navigateWithTransition],
  );

  const handleSessionEstablished = useCallback(
    (targetSessionId: string, context: SessionEstablishedContext) =>
      registerOptimisticSession({ sessionId: targetSessionId, ...context }),
    [registerOptimisticSession],
  );

  const handleDashboardNewChat = useCallback(() => {
    if (selectedProject) {
      handleNewSession(selectedProject);
      return;
    }
    setActiveTab('chat');
  }, [handleNewSession, selectedProject, setActiveTab]);

  // 工作台外壳自己持有的浮层状态。这些以前分别住在 DesktopAppRail、Sidebar
  // 和 FleetView 里;导航栏拆掉之后统一收到外壳,互斥关闭由 closeOverlays 保证。
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [leoapiOpen, setLeoapiOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [localTool, setLocalTool] = useState<'leoapi' | 'feedback' | null>(null);
  // 非空时,右侧主区显示的是被接管的远程会话,而不是本机对话。
  const [remoteTarget, setRemoteTarget] = useState<RemoteTarget | null>(null);

  const closeOverlays = useCallback(() => {
    setRemoteOpen(false);
    setLeoapiOpen(false);
    setProjectDrawerOpen(false);
  }, []);

  const { remotes, onlineCount, localName, configured: fleetConfigured } = useFleetSnapshot();

  // 设置窗开合走 view transition(GUIDELINES 第 3 条);不支持时正常渲染。
  const openSettingsTab = useCallback((tab?: string) => {
    withViewTransition(() => {
      closeOverlays();
      openSettings(tab);
    });
  }, [closeOverlays, openSettings]);

  /**
   * 指挥条回车:在当前项目里开一个新会话,并把这句话作为第一条指令发出去。
   * 复用 ⌘K handoff 已经跑通的那条链路 —— 先切 provider,再开会话,再灌草稿,
   * 目标忙碌时由 handleSubmit 自己入队,不会吞掉这一次回车。
   */
  const startLocalRun = useCallback((prompt: string) => {
    if (!selectedProject) {
      setProjectDrawerOpen(true);
      return;
    }
    closeOverlays();
    setRemoteTarget(null);
    setActiveTab('chat');
    handleNewSession(selectedProject);
    window.dispatchEvent(new CustomEvent('leocodebox:handoff-draft', {
      detail: { text: prompt, send: true },
    }));
  }, [closeOverlays, handleNewSession, selectedProject, setActiveTab]);

  /**
   * 目标选了远程 Mac 时,任务经中继下发到那台机器。中继不可达就退回本机,
   * 并把这句话留在指挥条里 —— 宁可让人重按一次,也不能假装发出去了。
   */
  const startRemoteRun = useCallback(async (machine: FleetMachine, prompt: string) => {
    closeOverlays();
    try {
      await apiClient.post('/api/leophone/fleet/sessions', {
        machine: machine.name,
        prompt,
      });
      await refreshProjectsSilently();
    } catch (error) {
      console.error('[AppContent] Remote run failed:', error);
      window.alert(t('workbench.remoteRunFailed', {
        machine: machine.name,
        defaultValue: `无法在 ${machine.name} 上创建会话,请检查中继连接。`,
      }));
    }
  }, [closeOverlays, refreshProjectsSilently, t]);

  /** 接管远程会话 = 在主区挂上那台机器的事件流(全量回放 + 实时跟随)。 */
  const takeOverRemote = useCallback((machine: FleetMachine, remoteSessionId?: string) => {
    closeOverlays();
    const session = remoteSessionId
      ? machine.sessions?.find((item) => item.session_id === remoteSessionId)
      : machine.sessions?.[0];
    const sessionId = remoteSessionId ?? session?.session_id;
    if (!sessionId) return;
    withViewTransition(() => {
      setRemoteTarget({ machine: machine.name, sessionId, harness: session?.harness });
    });
  }, [closeOverlays]);

  const selectRailSession = useCallback((session: ProjectSession, project: Project) => {
    closeOverlays();
    setRemoteTarget(null);
    setActiveTab('chat');
    // 会话列表是跨项目的平铺视图,所以要像侧栏那样先给会话打上归属项目的
    // projectId —— 路由跳转后靠它把 selectedProject 校准到正确的项目。
    handleSessionSelect({ ...session, __projectId: project.projectId });
  }, [closeOverlays, handleSessionSelect, setActiveTab]);

  // 命令面板要能到达外壳里的这几个入口(导航栏没了,⌘K 是唯一的替代)。
  useEffect(() => {
    const openProjects = () => { closeOverlays(); setProjectDrawerOpen(true); };
    const openLeoapi = () => { closeOverlays(); setLeoapiOpen(true); };
    const openLog = () => { closeOverlays(); setLocalTool('feedback'); };
    window.addEventListener('leocodebox:open-projects', openProjects);
    window.addEventListener('leocodebox:open-leoapi', openLeoapi);
    window.addEventListener('leocodebox:open-local-log', openLog);
    return () => {
      window.removeEventListener('leocodebox:open-projects', openProjects);
      window.removeEventListener('leocodebox:open-leoapi', openLeoapi);
      window.removeEventListener('leocodebox:open-local-log', openLog);
    };
  }, [closeOverlays]);

  // 桌面端菜单栏与旧的 open-local-tool 事件仍然指向这两个本地工具页。
  useEffect(() => {
    const unsubscribe = window.leocodeboxDesktopTools?.onOpenModal((tool) => {
      if (tool === 'leoapi') { closeOverlays(); setLeoapiOpen(true); }
      if (tool === 'feedback') { closeOverlays(); setLocalTool('feedback'); }
    });
    const handleLocalTool = (event: Event) => {
      const tool = (event as CustomEvent<'leoapi' | 'feedback'>).detail;
      if (tool === 'leoapi') { closeOverlays(); setLeoapiOpen(true); }
      if (tool === 'feedback') { closeOverlays(); setLocalTool('feedback'); }
    };
    window.addEventListener('leocodebox:open-local-tool', handleLocalTool);
    return () => {
      unsubscribe?.();
      window.removeEventListener('leocodebox:open-local-tool', handleLocalTool);
    };
  }, [closeOverlays]);

  return (
    <div
      className="leocodebox-app-shell fixed inset-0 flex flex-col bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      {!isMobile && (
        <WorkbenchTitleBar
          localName={localName}
          remotes={remotes}
          onlineCount={onlineCount}
          fleetConfigured={fleetConfigured}
          remoteOpen={remoteOpen}
          onToggleRemote={() => setRemoteOpen((open) => { closeOverlays(); return !open; })}
          onTakeOver={takeOverRemote}
          onOpenLeoapi={() => setLeoapiOpen((open) => { closeOverlays(); return !open; })}
          onOpenPalette={() => {
            closeOverlays();
            window.dispatchEvent(new CustomEvent('leocodebox:open-command-palette'));
          }}
          onOpenSettings={() => openSettingsTab()}
        />
      )}

      {!isMobile && (
        <CommandBar
          project={selectedProject}
          localName={localName}
          remotes={remotes}
          onOpenAgentSettings={() => openSettingsTab('agents')}
          onStartLocalRun={startLocalRun}
          onStartRemoteRun={(machine, prompt) => { void startRemoteRun(machine, prompt); }}
        />
      )}

      <div className="relative z-10 flex min-h-0 flex-1">
        {!isMobile && (
          <SessionRail
            projects={projects}
            selectedSessionId={selectedSession?.id ?? sessionId ?? null}
            activeSessions={processingSessions}
            attentionSessionIds={sidebarSharedProps.attentionSessionIds}
            remotes={remotes}
            localName={localName}
            onSelectLocal={selectRailSession}
            onTakeOverRemote={takeOverRemote}
          />
        )}

        <div className="leocodebox-workspace flex min-w-0 flex-1 flex-col">
          {remoteTarget ? (
            <RemoteSessionPanel target={remoteTarget} onClose={() => setRemoteTarget(null)} />
          ) : projectsError ? (
            <main className="flex min-w-0 flex-1 items-center justify-center p-6">
              <div role="alert" className="max-w-lg border border-destructive/40 bg-card p-6 text-center">
                <h2 className="text-base font-semibold text-foreground">{t('errorBoundary.projectsLoad')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{projectsError}</p>
                <button
                  type="button"
                  onClick={() => void fetchProjects()}
                  className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                >
                  {t('errorBoundary.retry')}
                </button>
              </div>
            </main>
          ) : <MainContent
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            ws={ws}
            sendMessage={sendMessage}
            isMobile={isMobile}
            onMenuClick={handleOpenSidebar}
            isLoading={isLoadingProjects}
            onInputFocusChange={setIsInputFocused}
            onSessionProcessing={markSessionProcessing}
            onSessionIdle={markSessionIdle}
            processingSessions={processingSessions}
            onNavigateToSession={handleNavigateToSession}
            onSessionEstablished={handleSessionEstablished}
            onShowSettings={openSettings}
            onStartNewChat={handleDashboardNewChat}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
          />}
        </div>
      </div>

      <WorkspaceStatusBar
        selectedProject={selectedProject}
        runningCount={processingSessions.size}
        activeProvider={selectedSession?.__provider ?? null}
        onOpenLocalLog={() => { closeOverlays(); setLocalTool('feedback'); }}
      />

      <ProjectDrawer
        open={projectDrawerOpen}
        onClose={() => setProjectDrawerOpen(false)}
        sidebarProps={sidebarSharedProps}
      />

      {leoapiOpen && (
        <LeoapiPanel
          onClose={() => setLeoapiOpen(false)}
          onOpenFullSwitch={() => { setLeoapiOpen(false); setLocalTool('leoapi'); }}
          onOpenCredentials={() => { setLeoapiOpen(false); openSettingsTab('api'); }}
        />
      )}

      {localTool && (
        <LocalToolModal
          title={localTool === 'leoapi' ? t('sidebar:localUi.leoapiSwitch') : t('sidebar:localUi.localLog')}
          src={localTool === 'leoapi' ? '/leocodebox-switch.html?embedded=1' : '/leocodebox-feedback.html?embedded=1'}
          onClose={() => setLocalTool(null)}
        />
      )}

      <CommandPalette
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettingsTab()}
        onShowTab={setActiveTab}
      />
      <SettingsHost
        isOpen={sidebarSharedProps.showSettings}
        initialTab={sidebarSharedProps.settingsInitialTab}
        projects={sidebarSharedProps.projects}
        onClose={sidebarSharedProps.onCloseSettings}
      />
    </div>
  );
}
