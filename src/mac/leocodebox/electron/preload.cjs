const { contextBridge, ipcRenderer } = require('electron');

function isLeocodeboxAppOrigin(location) {
  if (isFirstPartyShellLocation(location)) return true;

  if (location.protocol === 'http:') {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  }

  return location.protocol === 'https:' && (
    location.hostname === 'leocodebox.local' || location.hostname.endsWith('.leocodebox.local')
  );
}

function isFirstPartyShellLocation(location) {
  return location.protocol === 'file:'
    && location.pathname.replace(/\\/g, '/').endsWith('/electron/launcher/index.html');
}

function isLocalHttpOrigin(location) {
  return location.protocol === 'http:'
    && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
}

function installLocalOnlyAuthToken(location) {
  if (!isLocalHttpOrigin(location)) return false;

  try {
    const languageMigrationKey = 'leocodebox-language-default-v1';
    if (!window.localStorage.getItem(languageMigrationKey)) {
      if (!window.localStorage.getItem('userLanguage')) {
        window.localStorage.setItem('userLanguage', 'zh-CN');
      }
      window.localStorage.setItem(languageMigrationKey, '1');
    }

    const token = ipcRenderer.sendSync('leocodebox:get-local-auth-token', location.origin);
    if (typeof token === 'string' && token) {
      window.localStorage.setItem('auth-token', token);
      return true;
    }
  } catch (error) {
    console.warn('[leocodebox] Could not install local auth token:', error?.message || error);
  }
  return false;
}

function onDesktopStateUpdated(callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('leocodebox-desktop:state-updated', listener);
  return () => {
    ipcRenderer.removeListener('leocodebox-desktop:state-updated', listener);
  };
}

const localAuthReady = installLocalOnlyAuthToken(window.location);

if (isLocalHttpOrigin(window.location)) {
  const localBridge = { enabled: true, authReady: localAuthReady };
  if (window.location.pathname === '/leocodebox-switch.html') {
    localBridge.openMain = () => ipcRenderer.invoke('leocodebox-desktop:open-local');
  }
  contextBridge.exposeInMainWorld('leocodeboxLocal', Object.freeze(localBridge));
}

if (isLeocodeboxAppOrigin(window.location)) {
  contextBridge.exposeInMainWorld('leocodeboxDesktopNotifications', {
    getState: () => ipcRenderer.invoke('leocodebox-desktop:get-state'),
    update: (settings) => ipcRenderer.invoke('leocodebox-desktop:update-desktop-notifications', settings),
    onStateUpdated: onDesktopStateUpdated,
  });
}

if (isLocalHttpOrigin(window.location)) {
  contextBridge.exposeInMainWorld('leocodeboxDesktopUpdater', {
    getState: () => ipcRenderer.invoke('leocodebox-desktop:update-get-state'),
    setGithubToken: (token) => ipcRenderer.invoke('leocodebox-desktop:update-set-token', token),
    checkForUpdates: () => ipcRenderer.invoke('leocodebox-desktop:update-check'),
    downloadUpdate: () => ipcRenderer.invoke('leocodebox-desktop:update-download'),
    installUpdate: () => ipcRenderer.invoke('leocodebox-desktop:update-install'),
    onStateChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('leocodebox-desktop:update-state', listener);
      return () => ipcRenderer.removeListener('leocodebox-desktop:update-state', listener);
    },
  });
  contextBridge.exposeInMainWorld('leocodeboxDesktopTools', {
    setThemeMode: (mode) => ipcRenderer.invoke('leocodebox-desktop:set-theme-mode', mode),
    setRunningBadge: (count) => ipcRenderer.invoke('leocodebox-desktop:set-running-badge', count),
    onOpenModal: (callback) => {
      const listener = (_event, tool) => callback(tool);
      ipcRenderer.on('leocodebox-desktop:open-modal', listener);
      return () => ipcRenderer.removeListener('leocodebox-desktop:open-modal', listener);
    },
  });
}

if (isFirstPartyShellLocation(window.location)) {
  contextBridge.exposeInMainWorld('leocodeboxDesktop', {
    connectCloud: () => ipcRenderer.invoke('leocodebox-desktop:connect-cloud'),
    disconnectCloud: () => ipcRenderer.invoke('leocodebox-desktop:disconnect-cloud'),
    copyDiagnostics: () => ipcRenderer.invoke('leocodebox-desktop:copy-diagnostics'),
    copyLocalWebUrl: () => ipcRenderer.invoke('leocodebox-desktop:copy-local-web-url'),
    getState: () => ipcRenderer.invoke('leocodebox-desktop:get-state'),
    openCloudDashboard: () => ipcRenderer.invoke('leocodebox-desktop:open-cloud-dashboard'),
    openEnvironment: (environmentId) => ipcRenderer.invoke('leocodebox-desktop:open-environment', environmentId),
    runActiveEnvironmentAction: (action) => ipcRenderer.invoke('leocodebox-desktop:run-active-environment-action', action),
    openLocal: () => ipcRenderer.invoke('leocodebox-desktop:open-local'),
    openSwitch: () => ipcRenderer.invoke('leocodebox-desktop:open-switch'),
    openLocalWebUi: () => ipcRenderer.invoke('leocodebox-desktop:open-local-web-ui'),
    refreshEnvironments: () => ipcRenderer.invoke('leocodebox-desktop:refresh-environments'),
    refreshActiveTab: () => ipcRenderer.invoke('leocodebox-desktop:reload-active-tab'),
    showEnvironmentPicker: () => ipcRenderer.invoke('leocodebox-desktop:show-environment-picker'),
    showLauncher: () => ipcRenderer.invoke('leocodebox-desktop:show-launcher'),
    showLocalSettings: () => ipcRenderer.invoke('leocodebox-desktop:show-local-settings'),
    showDesktopSettings: () => ipcRenderer.invoke('leocodebox-desktop:show-desktop-settings'),
    closeSettingsWindow: () => ipcRenderer.invoke('leocodebox-desktop:close-settings-window'),
    showActiveEnvironmentActionsMenu: () => ipcRenderer.invoke('leocodebox-desktop:show-active-environment-actions-menu'),
    showEnvironmentActionsMenu: (environmentId) => ipcRenderer.invoke('leocodebox-desktop:show-environment-actions-menu', environmentId),
    switchTab: (tabId) => ipcRenderer.invoke('leocodebox-desktop:switch-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('leocodebox-desktop:close-tab', tabId),
    updateSetting: (key, value) => ipcRenderer.invoke('leocodebox-desktop:update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      ipcRenderer.on('leocodebox-desktop:launcher-command', (_event, command) => callback(command));
    },
  });
}
