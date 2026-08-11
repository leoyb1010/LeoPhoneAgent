import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, safeStorage, session, shell, webContents } from 'electron';
import updaterPackage from 'electron-updater';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopWindowManager } from './desktopWindow.js';
import { DesktopNotificationsController } from './desktopNotifications.js';
import { LocalServerController } from './localServer.js';
import { disableConflictingLegacyLaunchAgent } from './legacyMigration.js';
import { readProductVersion } from './productMetadata.js';
import { TabsController } from './tabs.js';
import { isFirstPartyShellUrl } from './trustPolicy.js';
import { DesktopUpdaterController, clearUpdaterTokenEnvironment } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = updaterPackage;

// electron-updater also reads GITHUB_TOKEN directly. Update credentials must
// come from the encrypted per-user settings store, never inherited env vars.
clearUpdaterTokenEnvironment();

const APP_NAME = 'leocodebox';
const APP_USER_MODEL_ID = 'com.leoyuan.leocodebox';
// Stable endpoint id for the (single) local desktop notification client.
const LOCAL_NOTIFICATIONS_DEVICE_ID = 'local-desktop';

const tabs = new TabsController();

async function configureProviderStoreEncryption() {
  if (!safeStorage.isEncryptionAvailable()) return;
  const keyPath = path.join(app.getPath('userData'), 'provider-store-key.enc');
  try {
    const encrypted = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64');
    const secret = safeStorage.decryptString(encrypted);
    if (secret) process.env.LEOCODEBOX_PROVIDER_KEY_SECRET = secret;
    return;
  } catch {
    // First launch or unreadable legacy key: create a new keychain-protected key.
  }
  const secret = randomBytes(32).toString('hex');
  const encrypted = safeStorage.encryptString(secret);
  await writeFile(keyPath, encrypted.toString('base64'), { mode: 0o600 });
  process.env.LEOCODEBOX_PROVIDER_KEY_SECRET = secret;
}

{
  const configuredProfilePath = String(process.env.LEOCODEBOX_USER_DATA_DIR || '').trim();
  const localProfilePath = configuredProfilePath
    ? path.resolve(configuredProfilePath)
    : path.join(app.getPath('appData'), APP_NAME, 'LocalProfile');
  mkdirSync(localProfilePath, { recursive: true });
  app.setPath('userData', localProfilePath);
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let activeTarget = { kind: 'launcher', name: APP_NAME, url: null };
let desktopWindow = null;
let localServer = null;
let desktopNotifications = null;
let desktopUpdater = null;
let isQuitting = false;
let productVersion = null;

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getProductVersion() {
  if (!productVersion) {
    productVersion = readProductVersion(getAppRoot(), app.getVersion());
  }
  return productVersion;
}

function getLauncherPath() {
  return path.join(__dirname, 'launcher', 'index.html');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  }
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDesktopNotificationsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-notifications-settings.json');
}

function getDesktopUpdaterSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-updater.json');
}

async function clearLocalOnlyWebCaches() {
  await rm(path.join(app.getPath('userData'), 'Service Worker'), { recursive: true, force: true }).catch((error) => {
    console.warn('[leocodebox] Could not remove stale service worker directory:', error?.message || error);
  });

  await session.defaultSession.clearStorageData({
    storages: ['serviceworkers', 'cachestorage'],
  }).catch((error) => {
    console.warn('[leocodebox] Could not clear stale service worker storage:', error?.message || error);
  });
}

function getDisplayTargetName() {
  return activeTarget?.name || APP_NAME;
}

// leocodebox is local-only: there is no cloud account or remote environment
// surface. The window/menu layer still branches on this shape, so keep it as
// a static answer instead of a controller.
function getCloudState() {
  return {
    account: null,
    environments: [],
    controlPlaneUrl: null,
    localOnly: true,
  };
}

function getLocalState() {
  return {
    desktopSettings: localServer.getSettings(),
    localServerRunning: Boolean(localServer.getLocalServerUrl()),
    localWebUrl: localServer.getLocalServerUrl(),
    shareableWebUrl: localServer.getShareableWebUrl(),
  };
}

function getDesktopState() {
  const localState = getLocalState();
  return {
    appVersion: getProductVersion(),
    localOnly: true,
    account: {
      connected: false,
      email: null,
      authState: 'local_only',
      requiresReconnect: false,
    },
    activeTarget,
    desktopSettings: localState.desktopSettings,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    localServerRunning: localState.localServerRunning,
    localStartupLogs: localServer.getStartupLogs(),
    cloudLoading: false,
    tabs: tabs.getSerializableTabs(),
    activeTabId: tabs.activeTabId,
    environments: [],
    desktopNotifications: desktopNotifications?.getState()
      || { enabled: false, supported: false, connectedCount: 0, targetCount: 0 },
    desktopUpdater: desktopUpdater?.getState() || null,
  };
}

function emitDesktopUpdaterState(state = desktopUpdater?.getState()) {
  if (!state) return;
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send('leocodebox-desktop:update-state', state);
    }
  }
  syncDesktopState();
}

async function openExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('Invalid external URL.');
  }

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error(`Refusing to open unsupported URL scheme: ${parsed.protocol}`);
  }

  await shell.openExternal(url);
}

function isAllowedLocalAuthOrigin(origin) {
  if (!localServer) return false;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') return false;
  const hostAllowed = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (!hostAllowed) return false;

  if (process.env.ELECTRON_DEV_URL) {
    try {
      if (new URL(process.env.ELECTRON_DEV_URL).origin === parsed.origin) return true;
    } catch {
      // Ignore malformed development URLs and fall through to the server origin check.
    }
  }

  const port = localServer.getLocalServerPort();
  if (!port) return false;
  return hostAllowed && Number.parseInt(parsed.port || '80', 10) === port;
}

function isTrustedLocalIpcSender(event, claimedOrigin = null) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  let senderOrigin;
  try {
    senderOrigin = new URL(senderUrl).origin;
  } catch {
    return false;
  }
  if (!isAllowedLocalAuthOrigin(senderOrigin)) return false;
  if (!claimedOrigin) return true;
  try {
    return new URL(String(claimedOrigin)).origin === senderOrigin;
  } catch {
    return false;
  }
}

function requireTrustedLocalIpcSender(event) {
  if (!isTrustedLocalIpcSender(event)) {
    throw new Error('Rejected privileged desktop request from an untrusted renderer.');
  }
}

// The first-party desktop shell chrome is loaded from disk (file://) and drives
// the privileged leocodeboxDesktop bridge; it is not an http-loopback origin, so
// isTrustedLocalIpcSender would reject it. Treat file:// as trusted here in
// addition to the loopback local server (covered by isTrustedLocalIpcSender).
function isFirstPartyShellSender(event) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isFirstPartyShellUrl(senderUrl, getLauncherPath());
}

function isTrustedDesktopUiSender(event) {
  return isFirstPartyShellSender(event) || isTrustedLocalIpcSender(event);
}

function requireTrustedDesktopUiSender(event) {
  if (!isTrustedDesktopUiSender(event)) {
    throw new Error('Rejected privileged desktop request from an untrusted renderer.');
  }
}

// localStartupLogs leaks the full PATH, absolute CLI paths, and the user's home
// directory, so strip it for any caller that is not the trusted first-party
// shell / local server.
function getDesktopStateForSender(event) {
  const state = getDesktopState();
  if (isTrustedDesktopUiSender(event)) return state;
  const { localStartupLogs, ...safeState } = state;
  return safeState;
}

async function showError(title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${title}: ${message}`);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'error',
    title,
    message: title,
    detail: message,
  });
}

function isExpectedNavigationAbort(error) {
  const message = error instanceof Error ? error.message : String(error);
  // ERR_ABORTED (-3) and ERR_FAILED (-2) both occur benignly when a view is torn
  // down mid-load (e.g. during quit or tab switch); neither should surface a dialog.
  return error?.code === 'ERR_ABORTED'
    || error?.code === 'ERR_FAILED'
    || message.includes('ERR_ABORTED')
    || message.includes('ERR_FAILED')
    || message.includes('(-3)')
    || message.includes('(-2)')
    || message.includes('Render frame was disposed')
    || message.includes('Script failed to execute');
}

function syncDesktopState() {
  if (!desktopWindow || isQuitting) return;
  desktopWindow.buildAppMenu();
  desktopWindow.emitDesktopState();
  if (activeTarget?.kind === 'local' && !localServer?.getLocalServerUrl()) {
    void desktopWindow.showLocalStartupTarget(
      localServer.getPendingTarget(),
      localServer.getStartupLogs(),
      localServer.getStartupPhase(),
    )
      .catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not update local startup log', error);
      });
  }
}

function setActiveTarget(target) {
  activeTarget = target;
}

function getDiagnosticsText() {
  const localState = getLocalState();
  return JSON.stringify({
    app: APP_NAME,
    version: getProductVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    appPath: getAppRoot(),
    userDataPath: app.getPath('userData'),
    activeTarget,
    localServerUrl: localState.localWebUrl,
    localServerPort: localServer.localServerPort,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    desktopSettings: localState.desktopSettings,
    localOnly: true,
    localStartupLogs: localServer.getStartupLogs().slice(-100),
  }, null, 2);
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Diagnostics copied',
    message: 'leocodebox desktop diagnostics were copied to the clipboard.',
  });
}

async function copyLocalWebUrl() {
  const browserUrl = await createLocalBrowserUrl();
  clipboard.writeText(browserUrl);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: '本机网页链接已复制',
    message: '请在两分钟内打开链接。',
    detail: '链接只可使用一次；进入后会自动清除地址中的临时授权信息。',
  });

  return getDesktopState();
}

async function createLocalBrowserUrl() {
  await localServer.ensureLocalServer();
  const localUrl = localServer.getLocalServerUrl();
  if (!localUrl) throw new Error('本机 leocodebox 服务尚未就绪。');

  const response = await fetch(new URL('/api/auth/local-bootstrap', localUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${localServer.getLocalAuthToken()}` },
  });
  if (!response.ok) throw new Error('无法创建本机浏览器授权。');
  const payload = await response.json();
  if (!payload?.code) throw new Error('本机浏览器授权返回无效。');

  const browserUrl = new URL(localUrl);
  browserUrl.searchParams.set('leocodebox_bootstrap', payload.code);
  return browserUrl.toString();
}

async function openLocalWebUi() {
  await openExternalUrl(await createLocalBrowserUrl());
  return getDesktopState();
}

let registeredHotkeyAccelerator = null;

// (Re)register the global show/hide hotkey from current settings. Returns false
// when the accelerator can't be claimed (already taken by the OS/another app).
function applyGlobalHotkey() {
  const { globalHotkeyEnabled, globalHotkeyAccelerator } = localServer.getSettings();
  if (registeredHotkeyAccelerator) {
    globalShortcut.unregister(registeredHotkeyAccelerator);
    registeredHotkeyAccelerator = null;
  }
  if (!globalHotkeyEnabled) return true;
  try {
    const ok = globalShortcut.register(globalHotkeyAccelerator, () => desktopWindow?.toggleMainWindow());
    if (ok) {
      registeredHotkeyAccelerator = globalHotkeyAccelerator;
      return true;
    }
  } catch {
    // fall through to the occupied-key path
  }
  return false;
}

async function updateDesktopSetting(key, value) {
  const result = await localServer.updateDesktopSetting(key, value);
  syncDesktopState();

  if (result.requiresRestartNotice) {
    await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
      type: 'info',
      title: 'Restart local server to apply',
      message: 'Local server changes apply the next time the local server starts.',
      detail: 'Quit leocodebox and stop the local server, then open Local leocodebox again.',
    });
  }

  if (key === 'globalHotkeyEnabled' || key === 'globalHotkeyAccelerator') {
    const ok = applyGlobalHotkey();
    if (!ok) {
      // Roll back the enable so the stored state matches reality, then tell the user.
      await localServer.updateDesktopSetting('globalHotkeyEnabled', false);
      syncDesktopState();
      await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
        type: 'warning',
        title: '快捷键被占用',
        message: '无法注册全局快捷键',
        detail: '该组合键可能已被系统或其他应用占用，请更换后再试。',
      });
    }
  }

  return getDesktopState();
}

async function openLocalInDesktop() {
  const existingTab = tabs.getTab('local');
  if (existingTab && localServer.getLocalServerUrl()) {
    await desktopWindow.showTarget(await localServer.getResolvedTarget());
    desktopWindow.showMainWindow();
    return getDesktopState();
  }

  const pendingTarget = localServer.getPendingTarget();
  tabs.upsertTarget(pendingTarget);
  setActiveTarget(pendingTarget);
  await desktopWindow.showLocalStartupTarget(pendingTarget, localServer.getStartupLogs(), localServer.getStartupPhase());
  desktopWindow.showMainWindow();
  desktopWindow.emitDesktopState();

  const target = await localServer.getResolvedTarget();
  await desktopWindow.showTarget(target);
  return getDesktopState();
}

async function openSwitchInDesktop() {
  await openLocalInDesktop();
  desktopWindow.emitLocalModal('leoapi');
  return getDesktopState();
}

/**
 * A notification click brings the workspace forward and deep-links straight
 * into the session that finished, so long-running agents can be left alone
 * and picked back up in one click.
 */
async function openNotificationTarget({ sessionId = null } = {}) {
  const window = desktopWindow?.getMainWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  await openLocalInDesktop();

  if (sessionId) {
    const baseUrl = localServer.getLocalServerUrl();
    if (baseUrl) {
      const targetUrl = new URL(`/session/${encodeURIComponent(sessionId)}`, baseUrl).toString();
      await desktopWindow.navigateActiveView(targetUrl);
    }
  }
  return getDesktopState();
}

function registerIpcHandlers() {
  // Registers a handler that first rejects any sender that is not the trusted
  // first-party desktop shell (file://) or the local leocodebox server (loopback
  // in local-only mode). Used for privileged, side-effectful channels so a
  // hijacked or navigated-away BrowserView cannot invoke them.
  const trustedHandle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      requireTrustedDesktopUiSender(event);
      return fn(event, ...args);
    });

  ipcMain.on('leocodebox:get-local-auth-token', (event, origin) => {
    event.returnValue = isTrustedLocalIpcSender(event, origin) ? localServer.getLocalAuthToken() : null;
  });

  ipcMain.handle('leocodebox-desktop:set-theme-mode', async (event, mode) => {
    requireTrustedLocalIpcSender(event);
    if (!['system', 'light', 'dark'].includes(mode)) {
      throw new Error('Invalid desktop theme mode.');
    }
    return updateDesktopSetting('themeMode', mode);
  });

  // Dock badge mirrors the number of running agent sessions so long tasks can
  // be watched from outside the app. The local web UI reports the count.
  ipcMain.handle('leocodebox-desktop:set-running-badge', (event, count) => {
    requireTrustedLocalIpcSender(event);
    const runningCount = Number.isInteger(count) && count > 0 ? count : 0;
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(runningCount > 0 ? String(runningCount) : '');
    }
    return true;
  });

  trustedHandle('leocodebox-desktop:copy-diagnostics', async () => {
    await copyDiagnostics();
    return getDesktopState();
  });

  trustedHandle('leocodebox-desktop:copy-local-web-url', async () => copyLocalWebUrl());
  // get-state is intentionally NOT gated with trustedHandle: it is also read
  // via the notifications bridge. Untrusted callers get a state with
  // localStartupLogs stripped.
  ipcMain.handle('leocodebox-desktop:get-state', (event) => getDesktopStateForSender(event));
  trustedHandle('leocodebox-desktop:open-local', async () => openLocalInDesktop());
  trustedHandle('leocodebox-desktop:open-switch', async () => openSwitchInDesktop());
  trustedHandle('leocodebox-desktop:open-local-web-ui', async () => openLocalWebUi());
  trustedHandle('leocodebox-desktop:reload-active-tab', async () => desktopWindow.reloadActiveTab());
  // Environment switching collapsed to "open the local workspace" when the
  // cloud surface was removed; the channel stays for older shell pages.
  trustedHandle('leocodebox-desktop:show-environment-picker', async () => openLocalInDesktop());
  trustedHandle('leocodebox-desktop:show-launcher', async () => {
    await desktopWindow.showLauncher();
    return getDesktopState();
  });
  // update-desktop-notifications is a designed-public app-origin channel (the
  // leocodebox web UI manages its own notification prefs), so it is not
  // sender-gated; its returned state is redacted for untrusted callers.
  ipcMain.handle('leocodebox-desktop:update-desktop-notifications', async (event, settings) => {
    await desktopNotifications?.saveSettings(settings);
    return getDesktopStateForSender(event);
  });
  trustedHandle('leocodebox-desktop:show-desktop-settings', async () => desktopWindow.showDesktopSettings());
  trustedHandle('leocodebox-desktop:show-local-settings', async () => desktopWindow.showLocalSettings());
  trustedHandle('leocodebox-desktop:close-settings-window', async () => {
    desktopWindow.closeSettingsWindow();
    return getDesktopState();
  });
  trustedHandle('leocodebox-desktop:switch-tab', async (_event, tabId) => desktopWindow.switchDesktopTab(tabId));
  trustedHandle('leocodebox-desktop:close-tab', async (_event, tabId) => desktopWindow.closeDesktopTab(tabId));
  trustedHandle('leocodebox-desktop:update-setting', async (_event, key, value) => updateDesktopSetting(key, value));
  ipcMain.handle('leocodebox-desktop:update-get-state', (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.getState();
  });
  ipcMain.handle('leocodebox-desktop:update-set-token', async (event, token) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.saveGithubToken(token);
  });
  ipcMain.handle('leocodebox-desktop:update-check', async (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.checkForUpdates();
  });
  ipcMain.handle('leocodebox-desktop:update-download', async (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.downloadUpdate();
  });
  ipcMain.handle('leocodebox-desktop:update-install', async (event) => {
    requireTrustedLocalIpcSender(event);
    await desktopUpdater.installUpdate(async () => {
      isQuitting = true;
      desktopNotifications?.stop();
      await localServer?.shutdownOwnedServer();
    });
    return desktopUpdater.getState();
  });
}

function registerAppEvents() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopen = desktopWindow ? desktopWindow.createWindow() : createDesktopWindow();
      void reopen.catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not reopen leocodebox', error);
      });
      return;
    }

    const window = desktopWindow?.getMainWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.on('before-quit', () => {
    desktopNotifications?.stop();
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    isQuitting = true;
    if (!localServer?.hasOwnedServer()) return;

    if (localServer.getSettings().keepLocalServerRunning) {
      // Warm resume across app restarts: leave the server running; the next
      // launch adopts it via the marker file instead of cold-starting.
      localServer.detachOwnedServer();
      return;
    }

    event.preventDefault();
    void localServer.shutdownOwnedServer().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    // Closing the window hides the app into the tray/Dock instead of quitting,
    // keeping the local server warm. Quit stays on ⌘Q / tray "退出".
    if (isQuitting) app.quit();
  });

  app.on('will-quit', () => {
    // Electron clears these on exit anyway; unregister explicitly for safety.
    globalShortcut.unregisterAll();
  });
}

async function createDesktopWindow() {
  // The window/menu layer still declares cloud-era actions behind localOnly
  // guards; feed it inert implementations instead of forking its menu code.
  const disabledCloudAction = async () => getDesktopState();

  desktopWindow = new DesktopWindowManager({
    appName: APP_NAME,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getRemoteEnvironmentMenuItems: () => [],
    getCloudState,
    getLocalState,
    tabs,
    actions: {
      copyDiagnostics,
      copyText: (text) => clipboard.writeText(text),
      clearCloudAccount: disabledCloudAction,
      connectCloudAccount: disabledCloudAction,
      getActiveTarget: () => activeTarget,
      getEnvironmentUrl: () => null,
      openEnvironmentInBrowser: disabledCloudAction,
      openEnvironmentInDesktop: disabledCloudAction,
      openEnvironmentInIde: disabledCloudAction,
      openEnvironmentInSsh: disabledCloudAction,
      openLocalInDesktop,
      openLocalWebUi,
      openCloudDashboard: disabledCloudAction,
      refreshCloudEnvironments: async () => [],
      setActiveTarget,
      showEnvironmentPicker: openLocalInDesktop,
      showError,
      startEnvironment: disabledCloudAction,
      stopEnvironment: disabledCloudAction,
      updateDesktopSetting,
      copyLocalWebUrl,
      openNotificationTarget,
      isAppQuitting: () => isQuitting,
      requestQuit: () => app.quit(),
    },
  });

  desktopWindow.createTray();
  desktopWindow.configurePermissions();
  await desktopWindow.createWindow();
}

function registerSingleInstance() {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    const window = desktopWindow?.getMainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;

  await app.whenReady();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: getProductVersion(),
    copyright: 'leocodebox by LeoYuan',
  });

  await clearLocalOnlyWebCaches();

  await configureProviderStoreEncryption();

  const legacyMigration = await disableConflictingLegacyLaunchAgent();
  if (legacyMigration.migrated) {
    console.info(`Disabled conflicting legacy CloudCLI LaunchAgent: ${legacyMigration.disabledPath}`);
  }

  localServer = new LocalServerController({
    appRoot: getAppRoot(),
    settingsPath: getSettingsPath(),
    isPackaged: app.isPackaged,
    appVersion: getProductVersion(),
    onChange: syncDesktopState,
  });
  desktopNotifications = new DesktopNotificationsController({
    settingsPath: getDesktopNotificationsSettingsPath(),
    appVersion: getProductVersion(),
    appName: APP_NAME,
    getDeviceId: () => LOCAL_NOTIFICATIONS_DEVICE_ID,
    getAccountEmail: () => null,
    // The only notification source is the local server itself.
    getRunningEnvironmentUrls: () => {
      const localUrl = localServer?.getLocalServerUrl();
      return localUrl ? [localUrl] : [];
    },
    getApiKey: () => '',
    getAuthToken: () => localServer?.getLocalAuthToken() || null,
    getIconPath: getWindowIconPath,
    openNotificationTarget,
    isWindowFocused: () => Boolean(desktopWindow?.getMainWindow()?.isFocused()),
    onChange: syncDesktopState,
  });
  desktopUpdater = new DesktopUpdaterController({
    appVersion: getProductVersion(),
    isPackaged: app.isPackaged,
    settingsPath: getDesktopUpdaterSettingsPath(),
    onChange: emitDesktopUpdaterState,
    updater: autoUpdater,
    storage: safeStorage,
  });

  await localServer.loadDesktopSettings();
  await desktopUpdater.load();
  await desktopNotifications.loadSettings();

  registerIpcHandlers();
  registerAppEvents();
  await createDesktopWindow();
  // Settings are already loaded and the window exists; arm the global hotkey.
  applyGlobalHotkey();
  await openLocalInDesktop();
  // The local server URL only exists now, so (re)connect the notification
  // stream after the workspace is up.
  void desktopNotifications.sync().catch((error) => {
    console.warn('[DesktopNotifications] sync failed:', error?.message || error);
  });
  if (desktopUpdater.getState().configured) {
    setTimeout(() => {
      void desktopUpdater.checkForUpdates();
    }, 15_000);
  }
}

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await showError('leocodebox failed to start', error);
    app.quit();
  });
}
