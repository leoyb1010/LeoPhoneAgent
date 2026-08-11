import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_GITHUB_OWNER = 'leoyb1010';
const DEFAULT_GITHUB_REPO = 'leocodebox';
const DEFAULT_GENERIC_FEED_URL = 'https://github.com/leoyb1010/leocodebox-updates/releases/latest/download/';
const UPDATE_CHECK_TIMEOUT_MS = 45_000;
export { VERSION_RESET_TARGET, LEGACY_UPDATE_BRIDGE_VERSION } from './versionBridge.js';
import { VERSION_RESET_TARGET, LEGACY_UPDATE_BRIDGE_VERSION } from './versionBridge.js';

function displayUpdateVersion(version, appVersion) {
  return appVersion === VERSION_RESET_TARGET && version === LEGACY_UPDATE_BRIDGE_VERSION
    ? VERSION_RESET_TARGET
    : version;
}

function createInitialState(appVersion) {
  return {
    status: 'idle',
    currentVersion: appVersion,
    latestVersion: null,
    configured: false,
    credentialRequired: true,
    progress: null,
    releaseName: null,
    releaseNotes: null,
    error: null,
  };
}

function normalizeReleaseNotes(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  return value
    .map((entry) => (typeof entry?.note === 'string' ? entry.note : ''))
    .filter(Boolean)
    .join('\n\n') || null;
}

function isAuthenticationError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('401')
    || text.includes('403')
    || text.includes('bad credentials')
    || text.includes('authentication')
    || text.includes('not found');
}

export function clearUpdaterTokenEnvironment(environment = process.env) {
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
}

export class DesktopUpdaterController {
  constructor({
    appVersion,
    isPackaged,
    settingsPath,
    onChange,
    updater,
    storage,
  }) {
    if (!updater || !storage) {
      throw new Error('DesktopUpdaterController requires updater and secure storage implementations.');
    }
    this.appVersion = appVersion;
    this.isPackaged = isPackaged;
    this.settingsPath = settingsPath;
    this.onChange = onChange;
    this.updater = updater;
    this.storage = storage;
    this.state = createInitialState(appVersion);
    this.githubToken = '';
    this.genericFeedUrl = String(process.env.LEOCODEBOX_UPDATE_URL || DEFAULT_GENERIC_FEED_URL).trim();
    this.eventsRegistered = false;
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.getState());
  }

  async load() {
    this.registerEvents();
    this.updater.autoDownload = false;
    // A normal quit must stay a real quit. Installation is triggered only by
    // the explicit restart-and-install action; otherwise a downloaded update
    // can unexpectedly reopen the app after the user exits.
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.logger = console;

    if (this.appVersion === VERSION_RESET_TARGET) {
      const originalIsUpdateSupported = typeof this.updater.isUpdateSupported === 'function'
        ? this.updater.isUpdateSupported.bind(this.updater)
        : null;
      this.updater.isUpdateSupported = async (info) => {
        if (info?.version === LEGACY_UPDATE_BRIDGE_VERSION) return false;
        return originalIsUpdateSupported ? originalIsUpdateSupported(info) : true;
      };
    }

    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const settings = JSON.parse(raw);
      const encryptedToken = typeof settings.githubToken === 'string' ? settings.githubToken : '';
      if (encryptedToken && this.storage.isEncryptionAvailable()) {
        this.githubToken = this.storage.decryptString(Buffer.from(encryptedToken, 'base64'));
      }
    } catch {
      this.githubToken = '';
    }

    this.configureFeed();
    return this.getState();
  }

  configureFeed() {
    if (this.genericFeedUrl) {
      this.updater.setFeedURL({ provider: 'generic', url: this.genericFeedUrl });
      this.setState({ configured: true, credentialRequired: false, error: null });
      return;
    }

    const token = this.githubToken;
    if (!token) {
      this.setState({
        status: 'authentication-required',
        configured: false,
        credentialRequired: true,
        error: null,
      });
      return;
    }

    this.updater.setFeedURL({
      provider: 'github',
      owner: DEFAULT_GITHUB_OWNER,
      repo: DEFAULT_GITHUB_REPO,
      private: true,
      token,
    });
    this.setState({ configured: true, credentialRequired: true, error: null });
  }

  async saveGithubToken(token) {
    const normalizedToken = String(token || '').trim();
    if (normalizedToken && !this.storage.isEncryptionAvailable()) {
      throw new Error('系统钥匙串当前不可用，更新凭据未保存。');
    }

    this.githubToken = normalizedToken;
    const settings = normalizedToken
      ? { githubToken: this.storage.encryptString(normalizedToken).toString('base64') }
      : {};

    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    this.configureFeed();
    return this.getState();
  }

  async checkForUpdates() {
    if (!this.isPackaged && process.env.LEOCODEBOX_ALLOW_DEV_UPDATE !== '1') {
      this.setState({
        status: 'development-build',
        error: '开发构建不执行自动更新；请在已安装的正式版中测试。',
      });
      return this.getState();
    }

    if (!this.state.configured) {
      this.setState({ status: 'authentication-required', error: null });
      return this.getState();
    }

    this.setState({ status: 'checking', error: null, progress: null });
    let timeout;
    try {
      await Promise.race([
        this.updater.checkForUpdates(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('检查更新超时，请检查网络后重试。')), UPDATE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.setState({
        status: isAuthenticationError(error) ? 'authentication-required' : 'error',
        configured: isAuthenticationError(error) ? false : this.state.configured,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
    return this.getState();
  }

  async downloadUpdate() {
    if (this.state.status !== 'available' && this.state.status !== 'error') {
      return this.getState();
    }

    this.setState({ status: 'downloading', error: null, progress: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setState({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.getState();
  }

  async installUpdate(beforeInstall) {
    if (this.state.status !== 'downloaded') {
      throw new Error('更新尚未下载完成。');
    }

    this.setState({ status: 'installing', error: null });
    await beforeInstall?.();
    this.updater.quitAndInstall(false, true);
  }

  registerEvents() {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;

    this.updater.on('checking-for-update', () => {
      this.setState({ status: 'checking', error: null });
    });
    this.updater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        latestVersion: displayUpdateVersion(info?.version, this.appVersion) || null,
        releaseName: info?.releaseName || null,
        releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
        error: null,
      });
    });
    this.updater.on('update-not-available', (info) => {
      this.setState({
        status: 'up-to-date',
        latestVersion: displayUpdateVersion(info?.version, this.appVersion) || this.appVersion,
        progress: null,
        error: null,
      });
    });
    this.updater.on('download-progress', (progress) => {
      this.setState({
        status: 'downloading',
        progress: Number.isFinite(progress?.percent) ? Math.round(progress.percent) : null,
      });
    });
    this.updater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        latestVersion: displayUpdateVersion(info?.version, this.appVersion) || this.state.latestVersion,
        progress: 100,
        error: null,
      });
    });
    this.updater.on('error', (error) => {
      this.setState({
        status: isAuthenticationError(error) ? 'authentication-required' : 'error',
        configured: isAuthenticationError(error) ? false : this.state.configured,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
