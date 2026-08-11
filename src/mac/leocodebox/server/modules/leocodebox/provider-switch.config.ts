import os from 'node:os';
import path from 'node:path';

import {
  getClaudeConfigDir,
  getCodexHome,
  getGeminiHome,
  getHermesHome,
  getOpenCodeConfigDir,
} from '../../shared/provider-runtime-paths.js';

export type ProviderSwitchTarget = {
  id: string;
  label: string;
  writable: boolean;
  configPaths: string[];
};

export const TARGETS: Record<string, ProviderSwitchTarget> = {
  claude: { id: 'claude', label: 'Claude Code', writable: true, configPaths: ['~/.claude/settings.json'] },
  codex: { id: 'codex', label: 'Codex', writable: true, configPaths: ['~/.codex/auth.json', '~/.codex/config.toml'] },
  opencode: { id: 'opencode', label: 'OpenCode', writable: true, configPaths: ['~/.config/opencode/opencode.json'] },
  cursor: { id: 'cursor', label: 'Cursor', writable: false, configPaths: ['~/Library/Application Support/Cursor/User/settings.json'] },
  gemini: { id: 'gemini', label: 'Gemini CLI', writable: true, configPaths: ['~/.gemini/.env'] },
  hermes: { id: 'hermes', label: 'Hermes Agent', writable: true, configPaths: ['~/.hermes/config.yaml'] },
};

export function homeDir(): string {
  return process.env.LEOCODEBOX_TEST_HOME || os.homedir();
}

export function expandHome(input: string): string {
  if (!input) return input;
  if (input === '~') return homeDir();
  if (input.startsWith('~/')) return path.join(homeDir(), input.slice(2));
  return input;
}

export function switchDir(): string {
  return path.join(homeDir(), '.leocodebox', 'switch');
}

export function providerModelCachePath(): string {
  return path.join(switchDir(), 'model-discovery-cache.json');
}

export function providerStorePath(): string {
  return path.join(switchDir(), 'providers.json');
}

export function targetConfigPaths(targetId: string): string[] {
  if (targetId === 'claude') return [path.join(getClaudeConfigDir(process.env, homeDir()), 'settings.json')];
  if (targetId === 'codex') {
    const codexHome = getCodexHome(process.env, homeDir());
    return [path.join(codexHome, 'auth.json'), path.join(codexHome, 'config.toml')];
  }
  if (targetId === 'opencode') return [path.join(getOpenCodeConfigDir(process.env, homeDir()), 'opencode.json')];
  if (targetId === 'gemini') return [path.join(getGeminiHome(process.env, homeDir()), '.env')];
  if (targetId === 'hermes') return [path.join(getHermesHome(process.env, homeDir()), 'config.yaml')];
  return (TARGETS[targetId]?.configPaths || []).map(expandHome);
}

export function displayConfigPath(filePath: string): string {
  const home = path.resolve(homeDir());
  const resolved = path.resolve(filePath);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
}
