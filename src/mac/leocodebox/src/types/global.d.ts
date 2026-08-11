export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    leocodeboxLocal?: { enabled: boolean; authReady?: boolean };
    leocodeboxDesktopTools?: {
      setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<unknown>;
      setRunningBadge?: (count: number) => Promise<unknown>;
      onOpenModal: (callback: (tool: 'settings' | 'leoapi' | 'feedback') => void) => () => void;
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
