import os from 'node:os';
import path from 'node:path';

function resolveConfiguredDirectory(value: string | undefined, fallback: string, homeDir: string): string {
  const configured = String(value || '').trim();
  if (!configured) return fallback;
  if (configured === '~') return homeDir;
  if (configured.startsWith(`~${path.sep}`)) return path.join(homeDir, configured.slice(2));
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(homeDir, configured);
}

export function getClaudeConfigDir(env = process.env, homeDir = os.homedir()): string {
  return resolveConfiguredDirectory(env.CLAUDE_CONFIG_DIR, path.join(homeDir, '.claude'), homeDir);
}

export function getCodexHome(env = process.env, homeDir = os.homedir()): string {
  return resolveConfiguredDirectory(env.CODEX_HOME, path.join(homeDir, '.codex'), homeDir);
}

export function getOpenCodeDataDir(env = process.env, homeDir = os.homedir()): string {
  if (env.OPENCODE_DATA_DIR?.trim()) {
    return resolveConfiguredDirectory(env.OPENCODE_DATA_DIR, '', homeDir);
  }
  const xdgDataHome = resolveConfiguredDirectory(
    env.XDG_DATA_HOME,
    path.join(homeDir, '.local', 'share'),
    homeDir,
  );
  return path.join(xdgDataHome, 'opencode');
}

export function getOpenCodeConfigDir(env = process.env, homeDir = os.homedir()): string {
  if (env.OPENCODE_CONFIG_DIR?.trim()) {
    return resolveConfiguredDirectory(env.OPENCODE_CONFIG_DIR, '', homeDir);
  }
  const xdgConfigHome = resolveConfiguredDirectory(
    env.XDG_CONFIG_HOME,
    path.join(homeDir, '.config'),
    homeDir,
  );
  return path.join(xdgConfigHome, 'opencode');
}

export function getGeminiHome(env = process.env, homeDir = os.homedir()): string {
  return resolveConfiguredDirectory(env.GEMINI_CLI_HOME, path.join(homeDir, '.gemini'), homeDir);
}

export function getHermesHome(env = process.env, homeDir = os.homedir()): string {
  return resolveConfiguredDirectory(env.HERMES_HOME, path.join(homeDir, '.hermes'), homeDir);
}
