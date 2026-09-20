export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    leocodeboxLocal?: {
      enabled: boolean;
      authReady?: boolean;
      refreshAuthToken?: () => boolean;
    };
    leocodeboxDesktopTools?: {
      setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<unknown>;
      setRunningBadge?: (count: number) => Promise<unknown>;
      keepAwake?: (on: boolean) => Promise<{ on?: boolean; blockers?: number }>;
      pickFolder?: () => Promise<{ path?: string; cancelled?: boolean }>;
      revealPath?: (target: string) => Promise<{ path: string }>;
      openPath?: (target: string) => Promise<{ path: string }>;
      openTerm?: (target: string) => Promise<{ path: string }>;
      openUrl?: (target: string) => Promise<{ url?: string }>;
      speakText?: (text: string) => Promise<{ ok?: boolean; chars?: number }>;
      printText?: (payload: { title?: string; text: string }) => Promise<{ printed?: boolean }>;
      saveDrop?: (input: { cwd: string; name?: string; content?: string; fromPath?: string }) => Promise<{ path: string; name: string }>;
      clipboardImage?: () => Promise<{ empty?: boolean; name?: string; content?: string }>;
      pickFiles?: () => Promise<{ cancelled?: boolean; paths?: string[] }>;
      notify?: (payload: {
        title: string;
        body: string;
        sessionId?: string;
        machine?: string;
        approvalId?: string;
        actions?: Array<{ choice: string; label: string }>;
      }) => Promise<{ shown?: boolean }>;
      onNoticeClick?: (callback: (row: { sessionId?: string | null; machine?: string | null }) => void) => () => void;
      onNoticeAction?: (callback: (row: {
        sessionId?: string | null;
        machine?: string | null;
        approvalId?: string | null;
        choice?: string | null;
      }) => void) => () => void;
      /** 桌面壳发过来的"打开某个东西":本地工具页 / 设置窗。 */
      onOpenModal: (
        callback: (tool: 'settings' | 'leoapi' | 'feedback') => void,
      ) => () => void;
    };
    leocodeboxDesktopUpdater?: {
      getState: () => Promise<DesktopUpdateState>;
      setGithubToken: (token: string) => Promise<DesktopUpdateState>;
      checkForUpdates: () => Promise<DesktopUpdateState>;
      downloadUpdate: () => Promise<DesktopUpdateState>;
      installUpdate: () => Promise<DesktopUpdateState>;
      onStateChanged: (callback: (state: DesktopUpdateState) => void) => () => void;
    };
  }

  type DesktopUpdateStatus =
    | 'idle'
    | 'authentication-required'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'up-to-date'
    | 'development-build'
    | 'error';

  type DesktopUpdateState = {
    status: DesktopUpdateStatus;
    currentVersion: string;
    latestVersion: string | null;
    configured: boolean;
    credentialRequired: boolean;
    progress: number | null;
    releaseName: string | null;
    releaseNotes: string | null;
    error: string | null;
  };

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
