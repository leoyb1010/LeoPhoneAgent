declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}

interface ElectronAPI {
  platform: string;
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  anySessionInTurn: () => Promise<boolean>;
  safeStorageStore: (key: string, value: string) => Promise<boolean>;
  safeStorageRead: (key: string) => Promise<string | null>;
  safeStorageRemove: (key: string) => Promise<void>;
  openFeishuOAuth: (authUrl: string, expectedState: string) => Promise<{ code: string } | { error: string }>;
}

interface Window {
  electronAPI: ElectronAPI;
}
