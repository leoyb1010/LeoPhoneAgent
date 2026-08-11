import fsSync, { promises as fsPromises } from 'node:fs';
import path from 'path';
import os from 'os';

import { spawn } from 'cross-spawn';


export type PluginManifest = {
  name: string;
  displayName: string;
  entry: string;
  version?: string;
  description?: string;
  author?: string;
  icon?: string;
  type?: string;
  slot?: string;
  server?: string | null;
  permissions?: string[];
};
export type InstalledPlugin = {
  name: string; displayName: string; version: string; description: string; author: string; icon: string;
  type: string; slot: string; entry: string; server: string | null; permissions: string[]; enabled: boolean;
  dirName: string; repoUrl: string | null;
};
type PluginsConfig = Record<string, { enabled?: boolean; secrets?: Record<string, unknown> }>;
type ValidationResult = { valid: boolean; error?: string };
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? ''); }

const PLUGINS_DIR = path.join(os.homedir(), '.leocodebox', 'plugins');
const PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.leocodebox', 'plugins.json');
const LEGACY_PLUGINS_DIR = path.join(os.homedir(), '.claude-code-ui', 'plugins');
const LEGACY_PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.claude-code-ui', 'plugins.json');

const REQUIRED_MANIFEST_FIELDS = ['name', 'displayName', 'entry'] as const;

/** Strip embedded credentials from a repo URL before exposing it to the client. */
function sanitizeRepoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL (e.g. SSH shorthand) — strip user:pass@ segment
    return raw.replace(/\/\/[^@/]+@/, '//');
  }
}
const ALLOWED_TYPES = ['react', 'module'];
const ALLOWED_SLOTS = ['tab'];

async function fileExists(filePath: string): Promise<boolean> {
  try { await fsPromises.access(filePath); return true; } catch { return false; }
}

export async function getPluginsDir(): Promise<string> {
  try {
    await fsPromises.access(PLUGINS_DIR);
  } catch {
    await fsPromises.mkdir(PLUGINS_DIR, { recursive: true });
    try {
      await fsPromises.cp(LEGACY_PLUGINS_DIR, PLUGINS_DIR, { recursive: true, force: false });
    } catch {
      // Legacy plugin migration is best-effort.
    }
  }
  return PLUGINS_DIR;
}

export async function getPluginsConfig(): Promise<PluginsConfig> {
  for (const configPath of [PLUGINS_CONFIG_PATH, LEGACY_PLUGINS_CONFIG_PATH]) {
    try {
      return JSON.parse(await fsPromises.readFile(configPath, 'utf8')) as PluginsConfig;
    } catch {
      // Try the next location; corrupted config starts fresh.
    }
  }
  return {};
}

export async function savePluginsConfig(config: PluginsConfig): Promise<void> {
  await fsPromises.mkdir(path.dirname(PLUGINS_CONFIG_PATH), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(PLUGINS_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateManifest(manifest: unknown): ValidationResult {
  const value = manifest as Partial<PluginManifest>;
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!value[field] || typeof value[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  // Sanitize name — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(value.name!)) {
    return { valid: false, error: 'Plugin name must only contain letters, numbers, hyphens, and underscores' };
  }

  if (value.type && !ALLOWED_TYPES.includes(value.type)) {
    return { valid: false, error: `Invalid plugin type: ${value.type}. Must be one of: ${ALLOWED_TYPES.join(', ')}` };
  }

  if (value.slot && !ALLOWED_SLOTS.includes(value.slot)) {
    return { valid: false, error: `Invalid plugin slot: ${value.slot}. Must be one of: ${ALLOWED_SLOTS.join(', ')}` };
  }

  // Validate entry is a relative path without traversal
  if (value.entry!.includes('..') || path.isAbsolute(value.entry!)) {
    return { valid: false, error: 'Entry must be a relative path without ".."' };
  }

  if (value.server !== undefined && value.server !== null) {
    if (typeof value.server !== 'string' || value.server.includes('..') || path.isAbsolute(value.server)) {
      return { valid: false, error: 'Server entry must be a relative path string without ".."' };
    }
  }

  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === 'string')) {
      return { valid: false, error: 'Permissions must be an array of strings' };
    }
  }

  return { valid: true };
}

const BUILD_TIMEOUT_MS = 60_000;

/** Run `npm run build` if the plugin's package.json declares a build script. */
function runBuildIfNeeded(dir: string, packageJsonPath: string, onSuccess: () => void, onError: (error: Error) => void): void {
  const startBuild = () => {
    const buildProcess = spawn('npm', ['run', 'build'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      buildProcess.removeAllListeners();
      buildProcess.kill();
      onError(new Error('npm run build timed out'));
    }, BUILD_TIMEOUT_MS);
    buildProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
    buildProcess.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return onError(new Error(`npm run build failed (exit code ${code}): ${stderr.trim()}`));
      onSuccess();
    });
    buildProcess.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onError(new Error(`Failed to spawn build: ${errorMessage(err)}`));
    });
  };

  void fsPromises.readFile(packageJsonPath, 'utf8')
    .then((raw) => {
      const pkg = JSON.parse(raw) as { scripts?: { build?: string } };
      if (pkg.scripts?.build) startBuild();
      else onSuccess();
    })
    .catch(() => onSuccess());
}

export async function scanPlugins(): Promise<InstalledPlugin[]> {
  const pluginsDir = await getPluginsDir();
  const config = await getPluginsConfig();
  const plugins: InstalledPlugin[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsPromises.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return plugins;
  }

  const seenNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
    const pluginDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8')) as PluginManifest;
    } catch {
      continue;
    }
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      console.warn(`[Plugins] Skipping ${entry.name}: ${validation.error}`);
      continue;
    }
    if (seenNames.has(manifest.name)) {
      console.warn(`[Plugins] Skipping ${entry.name}: duplicate plugin name "${manifest.name}"`);
      continue;
    }
    seenNames.add(manifest.name);

    let repoUrl: string | null = null;
    try {
      const gitConfig = await fsPromises.readFile(path.join(pluginDir, '.git', 'config'), 'utf8');
      const match = gitConfig.match(/url\s*=\s*(.+)/);
      if (match) {
        repoUrl = match[1].trim().replace(/\.git$/, '');
        if (repoUrl.startsWith('git@')) repoUrl = repoUrl.replace(/^git@([^:]+):/, 'https://$1/');
        repoUrl = sanitizeRepoUrl(repoUrl);
      }
    } catch { /* non-git plugin */ }

    plugins.push({
      name: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      icon: manifest.icon || 'Puzzle',
      type: manifest.type || 'module',
      slot: manifest.slot || 'tab',
      entry: manifest.entry,
      server: manifest.server || null,
      permissions: manifest.permissions || [],
      enabled: config[manifest.name]?.enabled !== false,
      dirName: entry.name,
      repoUrl,
    });
  }
  return plugins;
}

export async function getPluginDir(name: string): Promise<string | null> {
  const plugins = await scanPlugins();
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) return null;
  return path.join(await getPluginsDir(), plugin.dirName);
}

export async function resolvePluginAssetPath(name: string, assetPath: string): Promise<string | null> {
  const pluginDir = await getPluginDir(name);
  if (!pluginDir) return null;
  const resolved = path.resolve(pluginDir, assetPath);
  try {
    const realResolved = await fsPromises.realpath(resolved);
    const realPluginDir = await fsPromises.realpath(pluginDir);
    if (!realResolved.startsWith(realPluginDir + path.sep) && realResolved !== realPluginDir) return null;
    return realResolved;
  } catch {
    return null;
  }
}

export async function installPluginFromGit(url: string): Promise<PluginManifest> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Invalid URL: must be a non-empty string');
  }
  if (url.startsWith('-')) {
    throw new Error('Invalid URL: must not start with "-"');
  }

  const urlClean = url.replace(/\.git$/, '').replace(/\/$/, '');
  const repoName = urlClean.split('/').pop();
  if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) {
    throw new Error('Could not determine a valid directory name from the URL');
  }

  const pluginsDir = await getPluginsDir();

  return new Promise<PluginManifest>(async (resolve, reject) => {
    const targetDir = path.resolve(pluginsDir, repoName);

    // Ensure the resolved target directory stays within the plugins directory
    if (!targetDir.startsWith(pluginsDir + path.sep)) {
      return reject(new Error('Invalid plugin directory path'));
    }

    if (await fileExists(targetDir)) {
      return reject(new Error(`Plugin directory "${repoName}" already exists`));
    }

    // Clone into a temp directory so await scanPlugins() never sees a partially-installed plugin
    const tempDir = fsSync.mkdtempSync(path.join(pluginsDir, `.tmp-${repoName}-`));

    const cleanupTemp = (): void => {
      try { fsSync.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    };

    const finalize = (manifest: PluginManifest): void => {
      try {
        fsSync.renameSync(tempDir, targetDir);
      } catch (err) {
        cleanupTemp();
        return reject(new Error(`Failed to move plugin into place: ${errorMessage(err)}`));
      }
      resolve(manifest);
    };

    const gitProcess = spawn('git', ['clone', '--depth', '1', '--', url, tempDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', async (code) => {
      if (code !== 0) {
        cleanupTemp();
        return reject(new Error(`git clone failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Validate manifest exists
      const manifestPath = path.join(tempDir, 'manifest.json');
      if (!(await fileExists(manifestPath))) {
        cleanupTemp();
        return reject(new Error('Cloned repository does not contain a manifest.json'));
      }

      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8')) as PluginManifest;
      } catch {
        cleanupTemp();
        return reject(new Error('manifest.json is not valid JSON'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        cleanupTemp();
        return reject(new Error(`Invalid manifest: ${validation.error}`));
      }

      // Reject if another installed plugin already uses this name
      const existing = (await scanPlugins()).find((p) => p.name === manifest.name);
      if (existing) {
        cleanupTemp();
        return reject(new Error(`A plugin named "${manifest.name}" is already installed (in "${existing.dirName}")`));
      }

      // Run npm install if package.json exists.
      // --ignore-scripts prevents postinstall hooks from executing arbitrary code.
      const packageJsonPath = path.join(tempDir, 'package.json');
      if (await fileExists(packageJsonPath)) {
        const npmProcess = spawn('npm', ['install', '--ignore-scripts'], {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            cleanupTemp();
            return reject(new Error(`npm install for ${repoName} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(tempDir, packageJsonPath, () => finalize(manifest), (err) => { cleanupTemp(); reject(err); });
        });

        npmProcess.on('error', (err) => {
          cleanupTemp();
          reject(err);
        });
      } else {
        finalize(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      cleanupTemp();
      reject(new Error(`Failed to spawn git: ${errorMessage(err)}`));
    });
  });
}

export async function updatePluginFromGit(name: string): Promise<PluginManifest> {
  const pluginDir = await getPluginDir(name);
  return new Promise<PluginManifest>((resolve, reject) => {
    if (!pluginDir) {
      return reject(new Error(`Plugin "${name}" not found`));
    }

    // Only fast-forward to avoid silent divergence
    const gitProcess = spawn('git', ['pull', '--ff-only', '--'], {
      cwd: pluginDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(`git pull failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Re-validate manifest after update
      const manifestPath = path.join(pluginDir, 'manifest.json');
      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8')) as PluginManifest;
      } catch {
        return reject(new Error('manifest.json is not valid JSON after update'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        return reject(new Error(`Invalid manifest after update: ${validation.error}`));
      }

      // Re-run npm install if package.json exists
      const packageJsonPath = path.join(pluginDir, 'package.json');
      if (await fileExists(packageJsonPath)) {
        const npmProcess = spawn('npm', ['install', '--ignore-scripts'], {
          cwd: pluginDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            return reject(new Error(`npm install for ${name} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(pluginDir, packageJsonPath, () => resolve(manifest), (err) => reject(err));
        });
        npmProcess.on('error', (err) => reject(err));
      } else {
        resolve(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${errorMessage(err)}`));
    });
  });
}

export async function uninstallPlugin(name: string): Promise<void> {
  const pluginDir = await getPluginDir(name);
  if (!pluginDir) {
    throw new Error(`Plugin "${name}" not found`);
  }

  // On Windows, file handles may be released slightly after process exit.
  // Retry a few times with a short delay before giving up.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      fsSync.rmSync(pluginDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EBUSY' && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }

  // Remove from config
  const config = await getPluginsConfig();
  delete config[name];
  await savePluginsConfig(config);
}
