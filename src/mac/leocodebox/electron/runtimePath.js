import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PATH_SENTINEL_START = '__LEOCODEBOX_PATH_START__';
const PATH_SENTINEL_END = '__LEOCODEBOX_PATH_END__';
const ENV_SENTINEL_START = '__LEOCODEBOX_ENV_START__';
const ENV_SENTINEL_END = '__LEOCODEBOX_ENV_END__';
const SHELL_TIMEOUT_MS = 5000;
const AGENT_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CLI_PATH',
  'CODEX_HOME',
  'CODEX_CLI_PATH',
  'GEMINI_CLI_HOME',
  'HERMES_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DATA_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NVM_DIR',
  'PNPM_HOME',
  'VOLTA_HOME',
  'MISE_DATA_DIR',
  'FNM_DIR',
  'BUN_INSTALL',
  'ASDF_DATA_DIR',
  'PATH',
]);

function splitPath(value, delimiter = path.delimiter) {
  return String(value || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function addUnique(entries, value) {
  if (!value) return;
  const normalized = path.normalize(value);
  if (!entries.includes(normalized)) entries.push(normalized);
}

function listVersionBins(root, suffix, dependencies) {
  try {
    return dependencies.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, ...suffix));
  } catch {
    return [];
  }
}

export function parseLoginShellPath(output) {
  const text = String(output || '');
  const start = text.lastIndexOf(PATH_SENTINEL_START);
  if (start < 0) return '';
  const valueStart = start + PATH_SENTINEL_START.length;
  const end = text.indexOf(PATH_SENTINEL_END, valueStart);
  return end < 0 ? '' : text.slice(valueStart, end).trim();
}

export function readLoginShellPath({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'win32') return '';

  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const command = `printf '${PATH_SENTINEL_START}%s${PATH_SENTINEL_END}' "$PATH"`;

  try {
    const output = execFileSyncImpl(shell, ['-ilc', command], {
      encoding: 'utf8',
      env: {
        ...env,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SHELL_TIMEOUT_MS,
    });
    return parseLoginShellPath(output);
  } catch {
    return '';
  }
}

export function parseLoginShellEnvironment(output) {
  const text = String(output || '');
  const start = text.lastIndexOf(ENV_SENTINEL_START);
  if (start < 0) return {};
  const valueStart = start + ENV_SENTINEL_START.length;
  const end = text.indexOf(ENV_SENTINEL_END, valueStart);
  if (end < 0) return {};

  const values = {};
  for (const entry of text.slice(valueStart, end).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!AGENT_ENV_KEYS.has(key)) continue;
    values[key] = entry.slice(separator + 1);
  }
  return values;
}

export function readLoginShellEnvironment({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'win32') return {};
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const command = `printf '${ENV_SENTINEL_START}'; /usr/bin/env -0; printf '${ENV_SENTINEL_END}'`;
  try {
    const output = execFileSyncImpl(shell, ['-ilc', command], {
      encoding: 'utf8',
      env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SHELL_TIMEOUT_MS,
    });
    return parseLoginShellEnvironment(output);
  } catch {
    return {};
  }
}

/**
 * Async twin of readLoginShellEnvironment: same login-shell probe without
 * freezing the main-process event loop (a heavy zshrc can take seconds).
 */
export async function readLoginShellEnvironmentAsync({
  env = process.env,
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform === 'win32') return {};
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const command = `printf '${ENV_SENTINEL_START}'; /usr/bin/env -0; printf '${ENV_SENTINEL_END}'`;
  try {
    const { stdout } = await execFileImpl(shell, ['-ilc', command], {
      encoding: 'utf8',
      env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseLoginShellEnvironment(stdout);
  } catch {
    return {};
  }
}

export function getDesktopRuntimePath({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  readdirSyncImpl = fs.readdirSync,
  loginShellPath,
} = {}) {
  if (platform === 'win32') return env.PATH || '';

  const dependencies = { readdirSync: readdirSyncImpl };
  const entries = [];
  const resolvedLoginShellPath = loginShellPath === undefined
    ? readLoginShellPath({ env, platform, execFileSyncImpl })
    : loginShellPath;

  for (const entry of splitPath(env.LEOCODEBOX_AGENT_PATH)) addUnique(entries, entry);
  for (const entry of splitPath(resolvedLoginShellPath)) addUnique(entries, entry);

  const knownUserPaths = [
    env.PNPM_HOME,
    env.VOLTA_HOME ? path.join(env.VOLTA_HOME, 'bin') : null,
    env.BUN_INSTALL ? path.join(env.BUN_INSTALL, 'bin') : null,
    env.ASDF_DATA_DIR ? path.join(env.ASDF_DATA_DIR, 'shims') : null,
    env.MISE_DATA_DIR ? path.join(env.MISE_DATA_DIR, 'shims') : null,
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, 'bin'),
    path.join(homeDir, '.cursor', 'bin'),
    path.join(homeDir, '.opencode', 'bin'),
    path.join(homeDir, 'Library', 'pnpm'),
    path.join(homeDir, 'Library', 'pnpm', 'bin'),
    path.join(homeDir, '.local', 'share', 'pnpm'),
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.yarn', 'bin'),
    path.join(homeDir, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    path.join(homeDir, '.asdf', 'shims'),
    path.join(homeDir, '.nodenv', 'shims'),
    path.join(homeDir, '.local', 'share', 'mise', 'shims'),
    path.join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(homeDir, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin'),
  ];

  const versionManagerPaths = [
    ...listVersionBins(path.join(env.NVM_DIR || path.join(homeDir, '.nvm'), 'versions', 'node'), ['bin'], dependencies),
    ...listVersionBins(path.join(homeDir, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin'], dependencies),
  ];

  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/Applications/Cursor.app/Contents/Resources/app/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  for (const entry of knownUserPaths) addUnique(entries, entry);
  for (const entry of versionManagerPaths) addUnique(entries, entry);
  for (const entry of splitPath(env.PATH)) addUnique(entries, entry);
  for (const entry of commonPaths) addUnique(entries, entry);

  return entries.join(path.delimiter);
}

export function findExecutableInPath(command, runtimePath, {
  accessSyncImpl = fs.accessSync,
  platform = process.platform,
} = {}) {
  if (!command) return null;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try {
      accessSyncImpl(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  const extensions = platform === 'win32'
    ? splitPath(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM', ';')
    : [''];

  for (const directory of splitPath(runtimePath)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSyncImpl(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the merged desktop PATH.
      }
    }
  }

  return null;
}

export function getAgentCliDiagnostics(runtimePath) {
  return Object.fromEntries(
    ['claude', 'codex', 'cursor-agent', 'opencode', 'gemini', 'hermes', 'grok'].map((command) => [
      command,
      findExecutableInPath(command, runtimePath),
    ]),
  );
}
