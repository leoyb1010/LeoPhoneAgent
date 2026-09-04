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
import ProjectDrawer from '../workbench/ProjectDrawer';
import RemoteSessionPanel, { type RemoteTarget } from '../workbench/RemoteSessionPanel';
import VersionUpgradeModal from '../version-upgrade/view';
import { remoteLaunchFields, useFleetSnapshot, type FleetMachine } from '../workbench/useFleetSnapshot';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../chat/types/types';
import type { Project, ProjectSession } from '../../types/app';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useSessionApprovals } from '../../hooks/useSessionApprovals';
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
    pendingPrompt,
    consumePendingPrompt,
    queuePendingPrompt,
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

  // 会话列表的"待审批"标签只认这一份状态:真实的 permission_request。
  const { approvalSessionIds } = useSessionApprovals({ subscribe });

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

  // 工作台外壳自己持有的浮层状态。这些以前分别住在 DesktopAppRail、Sidebar
  // 和 FleetView 里;导航栏拆掉之后统一收到外壳,互斥关闭由 closeOverlays 保证。
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [localTool, setLocalTool] = useState<'feedback' | null>(null);
  // 状态栏的"有新版本 / 需重启"角标点开的更新卡。以前监听器住在 Sidebar 里,
  // 而 Sidebar 只在项目抽屉打开时才挂载 —— 抽屉关着时事件没人接,点角标毫无反应。
  // 这类"跨组件喊一嗓子"的入口必须落在常驻的外壳上。
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  // 非空时,右侧主区显示的是被接管的远程会话,而不是本机对话。
  const [remoteTarget, setRemoteTarget] = useState<RemoteTarget | null>(null);

  const closeOverlays = useCallback(() => {
    setRemoteOpen(false);
    setProjectDrawerOpen(false);
  }, []);

  /** 进入唯一的新任务表面；旧会话仍留在任务列表里，可随时返回。 */
  const openNewTask = useCallback(() => {
    closeOverlays();
    setRemoteTarget(null);
    setActiveTab('dashboard');
  }, [closeOverlays, setActiveTab]);

  useEffect(() => {
    const onNewTaskShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openNewTask();
      }
    };
    window.addEventListener('keydown', onNewTaskShortcut);
    return () => window.removeEventListener('keydown', onNewTaskShortcut);
  }, [openNewTask]);

  // 这两个开关以前把 closeOverlays() 写在 setState 的 updater 里。updater 必须是
  // 纯函数:React 会在同一批次里重放它,重放时那句 closeOverlays 又排入一次
  // setRemoteOpen(false),盖掉本次 toggle —— 表现就是"点了没反应,再点一下才开"。
  // 先互斥关闭,再翻转自己。
  const toggleRemote = useCallback(() => {
    closeOverlays();
    setRemoteOpen((open) => !open);
  }, [closeOverlays]);

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
   *
   * 首句作为 `handleNewSession` 的参数随会话重置**同源下发**,不再走
   * `handoff-draft` 那条独立的事件流 —— 那条路要么在 ChatInterface 还没挂载时
   * 空放(内容凭空消失),要么草稿落在会被 reset 冲掉的 ref 里(判据读到空串
   * 直接作废),两轮都是这么丢的。详见 src/hooks/pendingPrompt.ts 的注释。
   */
  const startLocalRun = useCallback((prompt: string) => {
    // 空输入不建会话:指挥条自己也拦了一道,这里兜底,免得别的入口漏拦。
    if (!prompt.trim()) return;
    if (!selectedProject) {
      queuePendingPrompt(prompt);
      setProjectDrawerOpen(true);
      return;
    }
    closeOverlays();
    setRemoteTarget(null);
    setActiveTab('chat');
    handleNewSession(selectedProject, prompt);
  }, [closeOverlays, handleNewSession, queuePendingPrompt, selectedProject, setActiveTab]);

  useEffect(() => {
    const onTreasuryPrompt = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === 'string' && text.trim()) startLocalRun(text.slice(0, 30_000));
    };
    window.addEventListener('leocodebox:launch-treasury-prompt', onTreasuryPrompt);
    return () => window.removeEventListener('leocodebox:launch-treasury-prompt', onTreasuryPrompt);
  }, [startLocalRun]);

  /**
   * 目标选了远程 Mac 时,任务经中继下发到那台机器。中继不可达就退回本机,
   * 并把这句话留在指挥条里 —— 宁可让人重按一次,也不能假装发出去了。
   */
  const startRemoteRun = useCallback(async (
    machineName: string,
    prompt: string,
    options: { harness?: string; cwd?: string; thinking?: string } = {},
  ) => {
    closeOverlays();
    try {
      const created = await apiClient.post<{ session_id?: string; harness?: string }>('/api/leophone/fleet/sessions', {
        machine: machineName,
        prompt,
        // 中继一直支持指定 harness/cwd,这里以前一个都没传 —— 于是远程任务无论
        // 用户选了谁,落到那台机器上永远是默认的 claude。和本机那条「选了 Codex
        // 发出去还是 Claude」是同一个病,只是躲在远程这条路上没被看见。
        ...(options.harness ? { harness: options.harness } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.thinking && options.thinking !== 'default' ? { thinking: options.thinking } : {}),
      });
      if (created.session_id) {
        setRemoteTarget({
          machine: machineName,
          sessionId: created.session_id,
          harness: created.harness ?? options.harness,
        });
        await refreshProjectsSilently();
        return true;
      }
      window.alert(t('workbench.remoteRunFailed', {
        machine: machineName,
        defaultValue: `无法在 ${machineName} 上创建会话,请检查中继连接。`,
      }));
      return false;
    } catch (error) {
      console.error('[AppContent] Remote run failed:', error);
      window.alert(t('workbench.remoteRunFailed', {
        machine: machineName,
        defaultValue: `无法在 ${machineName} 上创建会话,请检查中继连接。`,
      }));
      return false;
    }
  }, [closeOverlays, refreshProjectsSilently, t]);

  /** 接管远程会话 = 在主区挂上那台机器的事件流(全量回放 + 实时跟随)。 */
  const takeOverRemote = useCallback((machine: FleetMachine, remoteSessionId?: string) => {
    closeOverlays();
    const session = remoteSessionId
      ? machine.sessions?.find((item) => item.session_id === remoteSessionId)
      : machine.sessions?.[0];
    const sessionId = remoteSessionId ?? session?.session_id;
    if (!sessionId) {
      window.alert(t('workbench.remoteTakeOverFailed', {
        defaultValue: '这台机器上暂时没有可接管的会话。',
      }));
      return;
    }
    withViewTransition(() => {
      setRemoteTarget({ machine: machine.name, sessionId, harness: session?.harness });
    });
  }, [closeOverlays, t]);

  const selectRailSession = useCallback((session: ProjectSession, project: Project) => {
    closeOverlays();
    setRemoteTarget(null);
    setActiveTab('chat');
    // 会话列表是跨项目的平铺视图,所以要像侧栏那样先给会话打上归属项目的
    // projectId —— 路由跳转后靠它把 selectedProject 校准到正确的项目。
    handleSessionSelect({ ...session, __projectId: project.projectId });
  }, [closeOverlays, handleSessionSelect, setActiveTab]);

  useEffect(() => {
    const openVersionModal = () => setVersionModalOpen(true);
    window.addEventListener('leocodebox:open-version-modal', openVersionModal);
    return () => window.removeEventListener('leocodebox:open-version-modal', openVersionModal);
  }, []);

  // 命令面板与旧桌面消息统一落到真实页面；LeoAPI 不再拥有独立浮层。
  useEffect(() => {
    const openProjects = () => { closeOverlays(); setProjectDrawerOpen(true); };
    const openLeoapi = () => openSettingsTab('api');
    const openLog = () => { closeOverlays(); setLocalTool('feedback'); };
    window.addEventListener('leocodebox:open-projects', openProjects);
    window.addEventListener('leocodebox:open-leoapi', openLeoapi);
    window.addEventListener('leocodebox:open-local-log', openLog);
    return () => {
      window.removeEventListener('leocodebox:open-projects', openProjects);
      window.removeEventListener('leocodebox:open-leoapi', openLeoapi);
      window.removeEventListener('leocodebox:open-local-log', openLog);
    };
  }, [closeOverlays, openSettingsTab]);

  // 桌面端应用菜单发过来的导航意图。
  // (菜单栏额度面板的 `settings:quota` / `usage` 两个目的地已随托盘整体移除。)
  useEffect(() => {
    const unsubscribe = window.leocodeboxDesktopTools?.onOpenModal((tool) => {
      if (tool === 'leoapi') openSettingsTab('api');
      if (tool === 'feedback') { closeOverlays(); setLocalTool('feedback'); }
      if (tool === 'settings') openSettingsTab();
    });
    const handleLocalTool = (event: Event) => {
      const tool = (event as CustomEvent<'leoapi' | 'feedback'>).detail;
      if (tool === 'leoapi') openSettingsTab('api');
      if (tool === 'feedback') { closeOverlays(); setLocalTool('feedback'); }
    };
    window.addEventListener('leocodebox:open-local-tool', handleLocalTool);
    return () => {
      unsubscribe?.();
      window.removeEventListener('leocodebox:open-local-tool', handleLocalTool);
    };
  }, [closeOverlays, openSettingsTab]);

  return (
    <div
      className="leocodebox-app-shell fixed inset-0 flex flex-col bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      {!isMobile && (
        <WorkbenchTitleBar
          onStartNewTask={openNewTask}
          newTaskActive={activeTab === 'dashboard'}
          localName={localName}
          remotes={remotes}
          onlineCount={onlineCount}
          fleetConfigured={fleetConfigured}
          remoteOpen={remoteOpen}
          onToggleRemote={toggleRemote}
          onTakeOver={takeOverRemote}
          onOpenSettings={() => openSettingsTab()}
        />
      )}

      {!isMobile && activeTab === 'dashboard' && (
        <CommandBar
          project={selectedProject}
          localName={localName}
          remotes={remotes}
          onOpenAgentSettings={() => openSettingsTab('agents')}
          onOpenProjects={() => { closeOverlays(); setProjectDrawerOpen(true); }}
          onStartLocalRun={startLocalRun}
          onStartRemoteRun={(machine, prompt, provider, effort) => {
            return startRemoteRun(machine.name, prompt, remoteLaunchFields(machine, provider, {
              cwd: selectedProject?.fullPath || selectedProject?.path,
              thinking: effort,
            }));
          }}
        />
      )}

      <div className="relative z-10 flex min-h-0 flex-1">
        {!isMobile && (
          <SessionRail
            projects={projects}
            selectedSessionId={selectedSession?.id ?? sessionId ?? null}
            activeSessions={processingSessions}
            approvalSessionIds={approvalSessionIds}
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
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
            pendingPrompt={pendingPrompt}
            consumePendingPrompt={consumePendingPrompt}
          />}
        </div>
      </div>

      <WorkspaceStatusBar
        selectedProject={selectedProject}
        runningCount={processingSessions.size}
        activeProvider={selectedSession?.__provider ?? null}
        onOpenLocalLog={() => { closeOverlays(); setLocalTool('feedback'); }}
      />

      <VersionUpgradeModal isOpen={versionModalOpen} onClose={() => setVersionModalOpen(false)} />

      <ProjectDrawer
        open={projectDrawerOpen}
        onClose={() => setProjectDrawerOpen(false)}
        sidebarProps={sidebarSharedProps}
      />

      {localTool && (
        <LocalToolModal
          title={t('sidebar:localUi.localLog')}
          src="/leocodebox-feedback.html?embedded=1"
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
