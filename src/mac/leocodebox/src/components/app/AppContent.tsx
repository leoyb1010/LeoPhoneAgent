import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import SettingsHost from '../settings/view/SettingsHost';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../chat/types/types';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';
import { withViewTransition } from '../../utils/viewTransition';

import DesktopAppRail from './DesktopAppRail';
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
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
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

  const openLocalTool = useCallback((tool: 'leoapi' | 'feedback') => {
    window.dispatchEvent(new CustomEvent('leocodebox:open-local-tool', { detail: tool }));
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

  const showProjectSidebar = !isMobile && activeTab !== 'dashboard' && activeTab !== 'fleet';
  const isProjectIndependentTab = activeTab === 'dashboard' || activeTab === 'fleet';

  return (
    <div className="leocodebox-app-shell fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile && (
        <DesktopAppRail
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onShowSettings={() => openSettings()}
          onShowLeoapi={() => openLocalTool('leoapi')}
          onShowLocalLog={() => openLocalTool('feedback')}
        />
      )}
      {showProjectSidebar ? (
        <div className="leocodebox-project-sidebar h-full flex-shrink-0 border-r border-border/70">
          <Sidebar {...sidebarSharedProps} />
        </div>
      ) : isMobile ? (
        <div
          className={`sheet-overlay fixed inset-0 z-50 flex ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`sheet-panel relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} />
          </div>
        </div>
      ) : null}

      <div className="leocodebox-workspace flex min-w-0 flex-1 flex-col">
        {projectsError && !isProjectIndependentTab ? (
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
        <WorkspaceStatusBar
          selectedProject={selectedProject}
          runningCount={processingSessions.size}
          activeProvider={selectedSession?.__provider ?? null}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
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
