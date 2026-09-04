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

function requestLocalOnlyAuthToken(location) {
  if (!isLocalHttpOrigin(location)) return false;

  const token = ipcRenderer.sendSync('leocodebox:get-local-auth-token', location.origin);
  return typeof token === 'string' && token ? token : null;
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

    const token = requestLocalOnlyAuthToken(location);
    if (token) {
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
  const localBridge = {
    enabled: true,
    authReady: localAuthReady,
    refreshAuthToken: () => installLocalOnlyAuthToken(window.location),
  };
  // Leoapi 切换页是同源的独立工具页,需要「回到工作台」这条出口。
  // (菜单栏额度面板曾经也走这里;产品收缩后那条线已整体移除。)
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
    // 1.73.0 产品收缩删掉了云能力,主进程不再注册 connect-cloud /
    // open-environment / refresh-environments 等 8 个通道。这里也别再往
    // window 上挂它们的包装函数:挂着只会在被调用时抛
    // "No handler registered",比直接没有这个方法更难排查。
    copyDiagnostics: () => ipcRenderer.invoke('leocodebox-desktop:copy-diagnostics'),
    copyLocalWebUrl: () => ipcRenderer.invoke('leocodebox-desktop:copy-local-web-url'),
    getState: () => ipcRenderer.invoke('leocodebox-desktop:get-state'),
    openLocal: () => ipcRenderer.invoke('leocodebox-desktop:open-local'),
    openLocalWebUi: () => ipcRenderer.invoke('leocodebox-desktop:open-local-web-ui'),
    refreshActiveTab: () => ipcRenderer.invoke('leocodebox-desktop:reload-active-tab'),
    showEnvironmentPicker: () => ipcRenderer.invoke('leocodebox-desktop:show-environment-picker'),
    showLauncher: () => ipcRenderer.invoke('leocodebox-desktop:show-launcher'),
    showLocalSettings: () => ipcRenderer.invoke('leocodebox-desktop:show-local-settings'),
    showDesktopSettings: () => ipcRenderer.invoke('leocodebox-desktop:show-desktop-settings'),
    closeSettingsWindow: () => ipcRenderer.invoke('leocodebox-desktop:close-settings-window'),
    switchTab: (tabId) => ipcRenderer.invoke('leocodebox-desktop:switch-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('leocodebox-desktop:close-tab', tabId),
    updateSetting: (key, value) => ipcRenderer.invoke('leocodebox-desktop:update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      ipcRenderer.on('leocodebox-desktop:launcher-command', (_event, command) => callback(command));
    },
  });
}
