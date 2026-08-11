import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session, webContents as electronWebContents } from 'electron';

import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 44;
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
function isAllowedPermissionOrigin(sourceUrl, controlPlaneUrl, localServerUrl) {
  try {
    const source = new URL(sourceUrl);
    if ((source.hostname === '127.0.0.1' || source.hostname === 'localhost') && source.protocol === 'http:') {
      if (!localServerUrl) return false;
      const localServer = new URL(localServerUrl);
      return source.port === localServer.port;
    }
    if (source.protocol !== 'https:') {
      return false;
    }
    const controlPlane = new URL(controlPlaneUrl);
    return source.origin === controlPlane.origin || source.hostname.endsWith('.leocodebox.local');
  } catch {
    return false;
  }
}

function getWebContentsProcessId(contents) {
  return {
    osProcessId: typeof contents.getOSProcessId === 'function' ? contents.getOSProcessId() : null,
    processId: typeof contents.getProcessId === 'function' ? contents.getProcessId() : null,
  };
}

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getRemoteEnvironmentMenuItems,
    getCloudState,
    getLocalState,
    actions,
    tabs,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getDesktopState = getDesktopState;
    this.getDisplayTargetName = getDisplayTargetName;
    this.getRemoteEnvironmentMenuItems = getRemoteEnvironmentMenuItems;
    this.getCloudState = getCloudState;
    this.getLocalState = getLocalState;
    this.actions = actions;
    this.tabs = tabs;

    this.mainWindow = null;
    this.settingsWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.contentViewResizeTimer = null;
    this.viewHost = new ViewHost({
      appName: this.appName,
      getMainWindow: () => this.mainWindow,
      getContentViewBounds: () => this.getContentViewBounds(),
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
    });
  }

  getMainWindow() {
    return this.mainWindow;
  }

  showMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  // Global-hotkey target: hide when focused, otherwise surface the window.
  // Uses hide()/show() (not close, which is a real quit that frees the port).
  toggleMainWindow() {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && win.isFocused()) {
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => win.hide());
        win.setFullScreen(false);
      } else {
        win.hide();
      }
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentViewBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    };
  }

  resizeContentView() {
    this.viewHost.resizeActiveView();
    if (this.contentViewResizeTimer) clearTimeout(this.contentViewResizeTimer);
    this.contentViewResizeTimer = setTimeout(() => {
      this.contentViewResizeTimer = null;
      this.viewHost.resizeActiveView();
    }, 180);
  }

  detachActiveContentView() {
    this.viewHost.detachAll();
  }

  async showTabPlaceholder(target, message) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showTabPlaceholder(tabId, target, message);
  }

  async showLocalStartupTarget(target, logs, phase) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showLocalStartupTarget(tabId, target, logs, phase);
  }

  async showContentTarget(target) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showContentTarget(tabId, target);
  }

  destroyTabView(tabId) {
    this.viewHost.destroyTabView(tabId);
  }

  emitDesktopState() {
    const state = this.getDesktopState();
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('leocodebox-desktop:state-updated', state);
    }
    if (this.settingsWindow && !this.settingsWindow.webContents.isDestroyed()) {
      this.settingsWindow.webContents.send('leocodebox-desktop:state-updated', state);
    }
  }

  emitLauncherCommand(command) {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('leocodebox-desktop:launcher-command', command);
  }

  emitSettingsCommand(command) {
    if (!this.settingsWindow || this.settingsWindow.webContents.isDestroyed()) return;
    this.settingsWindow.webContents.send('leocodebox-desktop:launcher-command', command);
  }

  emitLocalModal(tool) {
    return this.viewHost.sendToActiveView('leocodebox-desktop:open-modal', tool);
  }

  syncSettingsWindowBounds() {
    if (!this.mainWindow || !this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.setBounds(this.mainWindow.getBounds());
  }

  async ensureSettingsWindow(sheet = 'desktop-settings') {
    if (!this.mainWindow) return null;

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.syncSettingsWindowBounds();
      this.emitSettingsCommand({ type: 'open-sheet', sheet });
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      parent: this.mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.syncSettingsWindowBounds();
    this.viewHost.configureChildWebContents(this.settingsWindow.webContents);
    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show());
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
    await this.settingsWindow.loadFile(this.getLauncherPath(), {
      query: { modal: '1', sheet },
    });
    return this.settingsWindow;
  }

  closeSettingsWindow() {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.close();
  }

  async showTarget(target, { trackTab = true } = {}) {
    if (!this.mainWindow) return;
    if (trackTab) {
      this.tabs.upsertTarget(target);
    }
    this.actions.setActiveTarget(target);
    this.buildAppMenu();
    this.mainWindow.setTitle(`${this.appName} - ${target.name}`);
    const finalUrl = await this.showContentTarget(target);
    this.emitDesktopState();
    return finalUrl;
  }

  async showLauncher() {
    if (!this.mainWindow) return;
    const target = { kind: 'launcher', name: this.appName, url: null };
    this.tabs.upsertTarget(target);
    this.actions.setActiveTarget(target);
    this.detachActiveContentView();
    this.buildAppMenu();
    this.mainWindow.setTitle(this.appName);
    this.mainWindow.webContents.focus();
    if (!this.launcherLoaded) {
      await this.mainWindow.loadFile(this.getLauncherPath());
      this.launcherLoaded = true;
    } else {
      this.emitDesktopState();
    }
  }

  async switchDesktopTab(tabId) {
    const tab = this.tabs.activate(tabId);
    if (!tab || !this.mainWindow) return this.getDesktopState();

    if (tab.id === 'home' || tab.kind === 'launcher') {
      await this.showLauncher();
      return this.getDesktopState();
    }

    if (!tab.target?.url) {
      throw new Error('This tab does not have a target URL.');
    }

    await this.showTarget(tab.target, { trackTab: false });
    return this.getDesktopState();
  }

  async reloadActiveTab() {
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.id === 'home' || activeTab.kind === 'launcher') {
      this.emitDesktopState();
      return this.getDesktopState();
    }

    const reloaded = this.viewHost.reloadTab(activeTab.id);
    if (!reloaded && activeTab.target?.url) {
      await this.showTarget(activeTab.target, { trackTab: false });
    }
    this.emitDesktopState();
    return this.getDesktopState();
  }

  async navigateActiveView(url) {
    const navigated = await this.viewHost.navigateActiveView(url);
    this.emitDesktopState();
    return navigated;
  }

  async readAuthTokenForTarget(url) {
    return this.viewHost.readLocalStorageValueForOrigin(url, AUTH_TOKEN_STORAGE_KEY);
  }

  openActiveTabDevTools() {
    if (this.viewHost.openActiveViewDevTools()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before opening active tab DevTools.'));
  }

  reloadActiveBrowserViewForDiagnostics() {
    if (this.viewHost.reloadActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before reloading the active BrowserView.'));
  }

  detachActiveBrowserViewForDiagnostics() {
    if (this.viewHost.detachActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before detaching the active BrowserView.'));
  }

  copyWebContentsDiagnostics() {
    const tabViewDiagnostics = this.viewHost.getTabViewDiagnostics();
    const tabViewByContentsId = new Map(
      tabViewDiagnostics
        .filter((item) => item.webContentsId != null)
        .map((item) => [item.webContentsId, item])
    );

    const rows = electronWebContents.getAllWebContents().map((contents) => {
      const destroyed = contents.isDestroyed();
      const processIds = destroyed ? { osProcessId: null, processId: null } : getWebContentsProcessId(contents);
      const tabView = tabViewByContentsId.get(contents.id);
      let owner = 'unknown';
      if (this.mainWindow?.webContents?.id === contents.id) {
        owner = 'main-window';
      } else if (this.settingsWindow?.webContents?.id === contents.id) {
        owner = 'settings-window';
      } else if (tabView) {
        owner = `browser-view:${tabView.tabId}`;
      }

      return {
        id: contents.id,
        owner,
        osProcessId: processIds.osProcessId,
        processId: processIds.processId,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        destroyed,
        focused: destroyed || typeof contents.isFocused !== 'function' ? false : contents.isFocused(),
        attached: tabView ? tabView.attached : null,
        active: tabView ? tabView.active : null,
      };
    });

    const activeTab = this.tabs.getActiveTab();
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      activeTabId: this.tabs.activeTabId,
      activeTab: activeTab
        ? {
            id: activeTab.id,
            title: activeTab.title,
            kind: activeTab.kind,
            targetUrl: activeTab.target?.url || null,
          }
        : null,
      tabViews: tabViewDiagnostics,
      webContents: rows,
    };

    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }

  async closeDesktopTab(tabId) {
    const tab = this.tabs.remove(tabId);
    if (!tab) return this.getDesktopState();
    this.destroyTabView(tabId);
    if (this.tabs.activeTabId === 'home') {
      await this.showLauncher();
    } else {
      this.emitDesktopState();
    }
    return this.getDesktopState();
  }

  buildEnvironmentActionsSubmenu(environment) {
    const items = [];
    const statusSuffix = environment.status === 'running' ? '' : ` (${environment.status})`;
    items.push({
      label: 'Open Environment',
      click: () => void this.actions.openEnvironmentInDesktop(environment)
        .catch((error) => this.actions.showError(`Could not open ${environment.name || environment.subdomain}${statusSuffix}`, error)),
    });
    items.push({
      label: 'Open in Browser',
      click: () => void this.actions.openEnvironmentInBrowser(environment)
        .catch((error) => this.actions.showError('Could not open environment in browser', error)),
    });
    items.push({
      label: 'Open in VS Code',
      click: () => void this.actions.openEnvironmentInIde(environment, 'vscode')
        .catch((error) => this.actions.showError('Could not open environment in VS Code', error)),
    });
    items.push({
      label: 'Open in Cursor',
      click: () => void this.actions.openEnvironmentInIde(environment, 'cursor')
        .catch((error) => this.actions.showError('Could not open environment in Cursor', error)),
    });
    items.push({
      label: 'Open SSH Terminal',
      click: () => void this.actions.openEnvironmentInSsh(environment)
        .catch((error) => this.actions.showError('Could not open SSH terminal', error)),
    });
    items.push({
      label: 'Copy Mobile/Web URL',
      click: () => this.actions.copyText(this.actions.getEnvironmentUrl(environment)),
    });
    if (environment.status !== 'running') {
      items.unshift({
        label: environment.status === 'paused' ? 'Resume' : 'Start',
        click: () => void this.actions.startEnvironment(environment)
          .catch((error) => this.actions.showError('Could not start environment', error)),
      });
    }
    if (environment.status === 'running') {
      items.push({
        label: 'Stop',
        click: () => void this.actions.stopEnvironment(environment)
          .catch((error) => this.actions.showError('Could not stop environment', error)),
      });
    }
    return items;
  }

  buildTrayEnvironmentSection() {
    const cloudState = this.getCloudState();
    if (cloudState.localOnly) return [];

    if (!cloudState.account?.apiKey) {
      return [
        {
          label: cloudState.account?.email ? `Reconnect ${cloudState.account.email}` : 'Login',
          click: () => void this.actions.connectCloudAccount()
            .catch((error) => this.actions.showError('Could not connect leocodebox account', error)),
        },
      ];
    }

    if (!cloudState.environments.length) {
      return [{ label: 'No environments found', enabled: false }];
    }

    return cloudState.environments.map((environment) => ({
      label: `${environment.name || environment.subdomain} - ${environment.status}`,
      submenu: this.buildEnvironmentActionsSubmenu(environment),
    }));
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const cloudState = this.getCloudState();
    const localOnly = Boolean(cloudState.localOnly);
    const remoteItems = localOnly ? [] : this.getRemoteEnvironmentMenuItems();
    const cloudAccountLabel = cloudState.account?.apiKey
      ? (cloudState.account?.email ? `Connected: ${cloudState.account.email}` : 'leocodebox Connected')
      : (cloudState.account?.email ? `Reconnect: ${cloudState.account.email}` : 'Connect leocodebox Account...');

    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `关于 ${this.appName}`, role: 'about' },
          { type: 'separator' },
	          {
		            label: '显示启动台',
	            accelerator: 'CmdOrCtrl+Shift+L',
	            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
	          },
	          ...(localOnly ? [] : [{
	            label: 'Switch Environment',
	            accelerator: 'CmdOrCtrl+Shift+E',
	            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('Could not switch environment', error)),
	          }]),
          {
            label: '诊断',
            submenu: [
              {
                label: '复制诊断信息',
                click: () => void this.actions.copyDiagnostics(),
              },
            ],
          },
          { type: 'separator' },
          {
            label: process.platform === 'darwin' ? `隐藏 ${this.appName}` : '隐藏',
            role: 'hide',
            visible: process.platform === 'darwin',
          },
          { label: '隐藏其他', role: 'hideOthers', visible: process.platform === 'darwin' },
          { label: '全部显示', role: 'unhide', visible: process.platform === 'darwin' },
          { type: 'separator', visible: process.platform === 'darwin' },
          { label: `退出 ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: '工作环境',
        submenu: [
          {
            label: '显示启动台',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
	          ...(localOnly ? [] : [{
	            label: 'Switch Environment',
	            accelerator: 'CmdOrCtrl+Shift+E',
	            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('Could not switch environment', error)),
	          },
	          { type: 'separator' }]),
          {
		            label: '打开本地 leocodebox',
	            accelerator: 'CmdOrCtrl+L',
	            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Could not open local leocodebox', error)),
          },
        ],
      },
	      ...(localOnly ? [] : [{
	        label: 'Cloud',
	        submenu: [
	          {
	            label: cloudAccountLabel,
	            accelerator: 'CmdOrCtrl+Shift+C',
	            click: () => void this.actions.connectCloudAccount().catch((error) => this.actions.showError('Could not connect leocodebox account', error)),
	          },
	          {
	            label: 'Refresh remote environments',
	            click: () => void this.actions.refreshCloudEnvironments().catch((error) => this.actions.showError('Could not load leocodebox environments', error)),
	            enabled: Boolean(cloudState.account?.apiKey),
	          },
	          {
	            label: 'Logout leocodebox Account',
	            click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('Could not logout', error)),
	            enabled: Boolean(cloudState.account?.apiKey),
	          },
	          { type: 'separator' },
	          {
	            label: 'Remote Environments',
	            submenu: remoteItems,
	          },
	        ],
	      }]),
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '显示',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          {
            label: '打开当前标签页开发工具',
            click: () => this.openActiveTabDevTools(),
          },
          {
            label: '复制 WebContents 诊断信息',
            click: () => this.copyWebContentsDiagnostics(),
          },
          {
            label: '重新加载当前视图',
            click: () => this.reloadActiveBrowserViewForDiagnostics(),
          },
          {
            label: '分离当前视图',
            click: () => this.detachActiveBrowserViewForDiagnostics(),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
		        label: '帮助',
	        submenu: [
	          ...(localOnly ? [] : [{
	            label: 'Open leocodebox.local',
	            click: () => void this.actions.openCloudDashboard(),
	          }]),
	          {
		            label: '复制诊断信息',
            click: () => void this.actions.copyDiagnostics(),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const cloudState = this.getCloudState();
    const localOnly = Boolean(cloudState.localOnly);
    const localState = this.getLocalState();

    const template = [
	      {
		        label: '本地',
        submenu: [
          {
		            label: localState.localServerRunning ? '在 leocodebox 中打开本地服务' : '启动本地 leocodebox',
	            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Could not open local leocodebox', error)),
          },
	        ],
	      },
	      ...(localOnly ? [] : [{
	        label: 'Remote environments',
	        submenu: this.buildTrayEnvironmentSection(),
	      },
	      { type: 'separator' },
	      {
	        label: cloudState.account?.email ? `Connected: ${cloudState.account.email}` : 'Login',
	        click: () => void this.actions.connectCloudAccount().catch((error) => this.actions.showError('Could not connect leocodebox account', error)),
	      },
	      {
	        label: 'Logout leocodebox Account',
	        click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('Could not logout', error)),
	        enabled: Boolean(cloudState.account?.apiKey),
	      }]),
      { type: 'separator' },
      {
        label: `退出 ${this.appName}`,
        role: 'quit',
      },
    ];

    this.tray.setToolTip(`${this.appName}${this.actions.getActiveTarget()?.name ? ` - ${this.actions.getActiveTarget().name}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async showDesktopSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    if (this.emitLocalModal('settings')) return this.getDesktopState();
    await this.ensureSettingsWindow('desktop-settings');
    return this.getDesktopState();
  }

  async showLocalSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('local-settings');
    return this.getDesktopState();
  }

  async showActiveEnvironmentActionsMenu() {
    if (!this.mainWindow) return this.getDesktopState();
    const activeTarget = this.actions.getActiveTarget();
    if (activeTarget?.kind !== 'remote') return this.getDesktopState();

    const environment = this.getCloudState().environments.find((item) => item.id === activeTarget.id);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  async showEnvironmentActionsMenu(environmentId) {
    if (!this.mainWindow) return this.getDesktopState();
    const environment = this.getCloudState().environments.find((item) => item.id === environmentId);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  configurePermissions() {
    const isAllowedPermission = (webContents, permission) => {
      const sourceUrl = webContents.getURL();
      // clipboard-sanitized-write backs navigator.clipboard.writeText —
      // without it every in-app "copy" button fails with a permission error.
      const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications']);
      return isAllowedPermissionOrigin(
        sourceUrl,
        this.getCloudState().controlPlaneUrl,
        this.getLocalState().localWebUrl,
      ) && allowedPermissions.has(permission);
    };

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isAllowedPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (!webContents) return false;
      return isAllowedPermission(webContents, permission);
    });
  }

  createTray() {
    if (this.tray) return;
    this.tray = new Tray(this.getTrayImage());
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      } else {
        this.mainWindow.show();
      }
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      show: false,
      backgroundColor: '#0f172a',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 14 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#111111' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: 44,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('Could not open external link', error));
      return { action: 'deny' };
    });

    this.mainWindow.on('resize', () => {
      this.resizeContentView();
      this.syncSettingsWindowBounds();
    });

    for (const eventName of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      this.mainWindow.on(eventName, () => this.resizeContentView());
    }

    this.mainWindow.on('move', () => {
      this.syncSettingsWindowBounds();
    });

    this.mainWindow.on('close', (event) => {
      if (this.actions.isAppQuitting?.()) return;
      event.preventDefault();
      // leocodebox owns the local server lifecycle: closing the app must be a
      // real quit so port 38473 and all child processes are released. Users who
      // explicitly enable keepLocalServerRunning still get the documented
      // detached-server behavior in main.js before-quit handling.
      this.actions.requestQuit?.();
    });

    this.mainWindow.on('closed', () => {
      if (this.contentViewResizeTimer) clearTimeout(this.contentViewResizeTimer);
      this.contentViewResizeTimer = null;
      this.viewHost.clear();
      this.settingsWindow = null;
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    this.buildAppMenu();
    await this.showLauncher();
  }
}
