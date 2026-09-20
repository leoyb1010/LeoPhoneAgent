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
      getOpenAtLogin?: () => Promise<{ on?: boolean }>;
      setOpenAtLogin?: (on: boolean) => Promise<{ on?: boolean }>;
      getGlobalHotkey?: () => Promise<{ on?: boolean }>;
      setGlobalHotkey?: (on: boolean) => Promise<{ on?: boolean }>;
      getAlwaysOnTop?: () => Promise<{ on?: boolean }>;
      setAlwaysOnTop?: (on: boolean) => Promise<{ on?: boolean }>;
      getVisibleOnAllWorkspaces?: () => Promise<{ on?: boolean }>;
      setVisibleOnAllWorkspaces?: (on: boolean) => Promise<{ on?: boolean }>;
      getContentProtection?: () => Promise<{ on?: boolean }>;
      setContentProtection?: (on: boolean) => Promise<{ on?: boolean }>;
      playDoneSound?: () => Promise<{ ok?: boolean }>;
      openLogs?: () => Promise<{ path?: string }>;
      openAccessibility?: () => Promise<{ ok?: boolean; url?: string }>;
      relaunch?: () => Promise<{ ok?: boolean }>;
      getAppFolder?: () => Promise<{ in?: boolean; can?: boolean }>;
      moveToApplications?: () => Promise<{ moved?: boolean; already?: boolean }>;
      openExtraWindow?: () => Promise<{ ok?: boolean }>;
      showEmojiPanel?: () => Promise<{ ok?: boolean }>;
      clearCache?: () => Promise<{ ok?: boolean }>;
      getBattery?: () => Promise<{ on?: boolean; can?: boolean }>;
      onBatteryChanged?: (callback: (row: { on?: boolean }) => void) => () => void;
      getThermal?: () => Promise<{ state?: string; hot?: boolean; can?: boolean }>;
      onThermalChanged?: (callback: (row: { state?: string; hot?: boolean }) => void) => () => void;
      onIdleBack?: (callback: (row: { back?: boolean }) => void) => () => void;
      onDisplayChanged?: (callback: (row: { kind?: string; count?: number }) => void) => () => void;
      getMemory?: () => Promise<{ low?: boolean; can?: boolean }>;
      onMemoryChanged?: (callback: (row: { low?: boolean }) => void) => () => void;
      onVolumeChanged?: (callback: (row: { kind?: string; count?: number }) => void) => () => void;
      onNetpathChanged?: (callback: () => void) => () => void;
      getAppLock?: () => Promise<{ on?: boolean }>;
      setAppLock?: (on: boolean) => Promise<{ on?: boolean }>;
      onAppLockChanged?: (callback: (row: { on?: boolean }) => void) => () => void;
      getCliInstall?: () => Promise<{ on?: boolean }>;
      setCliInstall?: (on: boolean) => Promise<{ on?: boolean }>;
      lastAbrupt?: () => Promise<{ abrupt?: boolean }>;
      cwdExists?: (target: string) => Promise<{ exists?: boolean }>;
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
      onLeoScheme?: (callback: (row: { cwd?: string | null }) => void) => () => void;
      onDockNew?: (callback: () => void) => () => void;
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
