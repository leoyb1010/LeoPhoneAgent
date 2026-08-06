/**
 * 终端默认 shell 偏好的 main 进程持久化（electron-store 后端）。
 *
 * 跟 `sidebarSettingsStore.ts` 同款 pattern：单独 JSON 文件（`userData/terminal-prefs.json`），
 * 跨 dev (http://localhost) / installed (file://) 共享。
 *
 * 设计取舍：不走 Drizzle 表，因为这是单值偏好，不值得跑 migration；电池容量小、
 * 启动开销也小。如果未来加更多终端偏好（per-tab 设置等）再统一迁过去。
 */

import Store from 'electron-store';

import type { ShellId } from './shellResolver.js';

interface TerminalPrefsShape {
  /** 'auto' = 走 resolveAutoDetectShell；具体 id = 锁定该 shell（不可用时仍 fallback auto） */
  defaultShellPref: ShellId;
}

const VALID_SHELL_IDS: ReadonlySet<ShellId> = new Set<ShellId>([
  'auto',
  'zsh',
  'bash',
  'fish',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
]);

let storeInstance: Store<TerminalPrefsShape> | null = null;

function getStore(): Store<TerminalPrefsShape> {
  if (!storeInstance) {
    storeInstance = new Store<TerminalPrefsShape>({
      name: 'terminal-prefs',
      defaults: { defaultShellPref: 'auto' },
      schema: {
        defaultShellPref: { type: 'string' },
      },
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export function getDefaultShellPref(): ShellId {
  const raw = getStore().get('defaultShellPref', 'auto');
  return VALID_SHELL_IDS.has(raw as ShellId) ? (raw as ShellId) : 'auto';
}

export function setDefaultShellPref(value: ShellId): void {
  if (!VALID_SHELL_IDS.has(value)) {
    throw new Error(`invalid shell id: ${value}`);
  }
  getStore().set('defaultShellPref', value);
}
