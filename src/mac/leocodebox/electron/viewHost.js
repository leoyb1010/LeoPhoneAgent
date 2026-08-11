import { BrowserView } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isTrustedNavigationUrl } from './trustPolicy.js';

const TARGET_LOAD_TIMEOUT_MS = 20000;
const ELECTRON_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER_PATH = path.join(ELECTRON_ROOT, 'placeholder.html');
const LAUNCHER_PATH = path.join(ELECTRON_ROOT, 'launcher', 'index.html');
const PLACEHOLDER_URL = pathToFileURL(PLACEHOLDER_PATH).href;
const CUSTOM_THEME_PATH = path.join(os.homedir(), '.leocodebox', 'custom-theme.css');
const DEFAULT_CUSTOM_THEME = `/* leocodebox personal theme. Edit this file, then reload the app view. */
:root {
  --primary: 221 83% 53%;
  --ring: 221 83% 53%;
  --radius: 0.375rem;
}
.dark {
  --background: 0 0% 7%;
  --card: 0 0% 10%;
  --popover: 0 0% 10%;
  --border: 0 0% 19%;
}
`;

async function loadPlaceholder(webContents, payload) {
  if (webContents.getURL() !== PLACEHOLDER_URL) {
    await webContents.loadFile(PLACEHOLDER_PATH);
  }
  await webContents.executeJavaScript(
    `window.leocodeboxRenderPlaceholder(${JSON.stringify(payload)})`,
    true,
  );
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function loadUrlWithTimeout(webContents, url, timeoutMs = TARGET_LOAD_TIMEOUT_MS) {
  let timedOut = false;
  let timeout = null;
  const loadPromise = webContents.loadURL(url);
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        webContents.stop();
      } catch {
        // Ignore teardown races while reporting the original timeout.
      }
      reject(new Error(`Timed out loading ${url} after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      loadPromise.catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ViewHost {
  constructor({ appName, getMainWindow, getContentViewBounds, getPreloadPath, openExternalUrl, showError }) {
    this.appName = appName;
    this.getMainWindow = getMainWindow;
    this.getContentViewBounds = getContentViewBounds;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.showError = showError;
    this.activeContentView = null;
    this.tabViews = new Map();
  }

  configureChildWebContents(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.showError('Could not open external link', error));
      return { action: 'deny' };
    });
    // Renderer-initiated navigations (link clicks, window.location, form posts)
    // must stay within app origins; otherwise the BrowserView would host an
    // arbitrary external site parasitically inside the app shell. Programmatic
    // loads (loadURL/loadFile) do not fire these events, so normal app startup
    // and in-app SPA routing are unaffected.
    webContents.on('will-navigate', (event, url) => {
      this.guardNavigation(webContents, event, url, true);
    });
    // will-frame-navigate additionally covers sub-frames (Electron >= 22).
    // Main-frame navigations are already handled by will-navigate above, so we
    // only act on sub-frames here to avoid double-handling.
    webContents.on('will-frame-navigate', (event) => {
      if (!event || event.isMainFrame) return;
      this.guardNavigation(webContents, event, event.url, false);
    });
    webContents.on('did-finish-load', () => {
      void this.applyCustomTheme(webContents);
    });
  }

  isAllowedInAppNavigation(webContents, targetUrl) {
    return isTrustedNavigationUrl({
      currentUrl: webContents.getURL(),
      targetUrl,
      allowedFilePaths: [PLACEHOLDER_PATH, LAUNCHER_PATH],
    });
  }

  guardNavigation(webContents, event, url, isMainFrame) {
    if (this.isAllowedInAppNavigation(webContents, url)) return;
    event.preventDefault();
    // Send external http(s) destinations to the system browser. Sub-frame and
    // non-http(s) navigations are simply blocked (opening them externally would
    // be wrong/unsupported).
    if (isMainFrame && isHttpUrl(url)) {
      void this.openExternalUrl(url).catch((error) => this.showError('Could not open external link', error));
    }
  }

  async applyCustomTheme(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    let currentUrl;
    try {
      currentUrl = new URL(webContents.getURL());
    } catch {
      return;
    }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(currentUrl.hostname)) return;

    try {
      await fs.mkdir(path.dirname(CUSTOM_THEME_PATH), { recursive: true });
      try {
        await fs.access(CUSTOM_THEME_PATH);
      } catch {
        await fs.writeFile(CUSTOM_THEME_PATH, DEFAULT_CUSTOM_THEME, { encoding: 'utf8', flag: 'wx' });
      }
      const css = await fs.readFile(CUSTOM_THEME_PATH, 'utf8');
      if (webContents.__leocodeboxThemeKey) {
        await webContents.removeInsertedCSS(webContents.__leocodeboxThemeKey).catch(() => {});
      }
      webContents.__leocodeboxThemeKey = await webContents.insertCSS(css, { cssOrigin: 'user' });
    } catch (error) {
      console.warn(`[leocodebox] Could not load custom theme at ${CUSTOM_THEME_PATH}:`, error?.message || error);
    }
  }

  detachAll() {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      for (const view of mainWindow.getBrowserViews()) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      // BrowserViews may already be gone during BrowserWindow teardown.
    }
    this.activeContentView = null;
  }

  detachActiveView() {
    const mainWindow = this.getMainWindow();
    const view = this.activeContentView;
    if (!mainWindow || mainWindow.isDestroyed() || !view) return false;
    try {
      if (mainWindow.getBrowserViews().includes(view)) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      return false;
    }
    this.activeContentView = null;
    return true;
  }

  getActiveView() {
    const view = this.activeContentView;
    if (!view || view.webContents.isDestroyed()) return null;
    return view;
  }

  openActiveViewDevTools() {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  reloadActiveView() {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  sendToActiveView(channel, payload) {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.send(channel, payload);
    return true;
  }

  async readLocalStorageValueForOrigin(originUrl, key) {
    let targetOrigin;
    try {
      targetOrigin = new URL(originUrl).origin;
    } catch {
      return null;
    }

    for (const view of this.tabViews.values()) {
      if (!view || view.webContents.isDestroyed()) continue;
      let viewOrigin;
      try {
        viewOrigin = new URL(view.webContents.getURL()).origin;
      } catch {
        continue;
      }
      if (viewOrigin !== targetOrigin) continue;

      try {
        const value = await view.webContents.executeJavaScript(
          `window.localStorage.getItem(${JSON.stringify(key)})`,
          true
        );
        return typeof value === 'string' && value ? value : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  getTabViewDiagnostics() {
    const mainWindow = this.getMainWindow();
    const attachedViews = new Set();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        for (const view of mainWindow.getBrowserViews()) {
          attachedViews.add(view);
        }
      } catch {
        // Ignore teardown races while gathering best-effort diagnostics.
      }
    }

    return Array.from(this.tabViews.entries()).map(([tabId, view]) => {
      const { webContents } = view;
      const destroyed = webContents.isDestroyed();
      return {
        tabId,
        webContentsId: destroyed ? null : webContents.id,
        url: destroyed ? null : webContents.getURL(),
        title: destroyed ? null : webContents.getTitle(),
        osProcessId: destroyed || typeof webContents.getOSProcessId !== 'function' ? null : webContents.getOSProcessId(),
        processId: destroyed || typeof webContents.getProcessId !== 'function' ? null : webContents.getProcessId(),
        attached: attachedViews.has(view),
        active: this.activeContentView === view,
        destroyed,
      };
    });
  }

  getOrCreateTabView(tabId) {
    let view = this.tabViews.get(tabId);
    if (view) return view;

    view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.configureChildWebContents(view.webContents);
    this.tabViews.set(tabId, view);
    return view;
  }

  attach(view) {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (this.activeContentView && this.activeContentView !== view) {
      this.detachAll();
    }
    this.activeContentView = view;
    try {
      if (!mainWindow.getBrowserViews().includes(view)) {
        mainWindow.addBrowserView(view);
      }
    } catch {
      return;
    }
    view.setBounds(this.getContentViewBounds());
    // BrowserView auto-resize can reuse stale parent bounds during macOS
    // maximize/full-screen transitions. DesktopWindowManager owns sizing.
    view.setAutoResize({ width: false, height: false });
  }

  resizeActiveView() {
    if (this.activeContentView) {
      this.activeContentView.setBounds(this.getContentViewBounds());
    }
  }

  async showTabPlaceholder(tabId, target, message) {
    const view = this.getOrCreateTabView(tabId);
    this.attach(view);
    const payload = { title: target.name || this.appName, message, logs: [] };
    await loadPlaceholder(view.webContents, payload);
    view.__leocodeboxStartupHtml = JSON.stringify(payload);
    view.__leocodeboxLoadedUrl = null;
  }

  async showLocalStartupTarget(tabId, target, logs, phase) {
    const view = this.getOrCreateTabView(tabId);
    if (view.webContents.isDestroyed()) return;
    if (view.__leocodeboxLoadingUrl || view.__leocodeboxStartupLoading) return;
    this.attach(view);
    const payload = { title: target.name || this.appName, message: '正在启动本地 leocodebox...', logs, phase };
    const signature = JSON.stringify(payload);
    if (view.__leocodeboxStartupHtml === signature) return;
    view.__leocodeboxStartupLoading = true;
    try {
      await loadPlaceholder(view.webContents, payload);
      view.__leocodeboxStartupHtml = signature;
      view.__leocodeboxLoadedUrl = null;
    } finally {
      view.__leocodeboxStartupLoading = false;
    }
  }

  async showContentTarget(tabId, target) {
    const loadUrl = target.loadUrl || target.url;
    if (!isHttpUrl(loadUrl)) {
      throw new Error(`Refusing to load unsupported app URL: ${loadUrl}`);
    }
    const view = this.getOrCreateTabView(tabId);
    this.attach(view);
    if (target.forceLoad || view.__leocodeboxLoadedUrl !== target.url) {
      view.__leocodeboxLoadingUrl = loadUrl;
      try {
        await loadUrlWithTimeout(view.webContents, loadUrl);
        view.__leocodeboxLoadedUrl = target.url;
        view.__leocodeboxStartupHtml = null;
        delete target.loadUrl;
        delete target.forceLoad;
      } finally {
        if (view.__leocodeboxLoadingUrl === loadUrl) {
          view.__leocodeboxLoadingUrl = null;
        }
      }
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.focus();
    }
    return view.webContents.getURL();
  }

  reloadTab(tabId) {
    const view = this.tabViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  async navigateActiveView(url) {
    const view = this.getActiveView();
    if (!view) return false;
    await loadUrlWithTimeout(view.webContents, url);
    view.__leocodeboxLoadedUrl = url;
    view.__leocodeboxStartupHtml = null;
    return true;
  }

  destroyTabView(tabId) {
    const view = this.tabViews.get(tabId);
    if (!view) return;
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.getBrowserViews().includes(view)) {
          mainWindow.removeBrowserView(view);
        }
      } catch {
        // Ignore teardown races; Electron owns final destruction during quit.
      }
    }
    if (this.activeContentView === view) {
      this.activeContentView = null;
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy();
      }
    } catch {
      // The view may already be destroyed by its parent BrowserWindow.
    }
    this.tabViews.delete(tabId);
  }

  clear() {
    this.tabViews.clear();
    this.activeContentView = null;
  }
}
