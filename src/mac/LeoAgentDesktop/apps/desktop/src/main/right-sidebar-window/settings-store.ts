/**
 * right-sidebar-window settings-store —— 「侧边栏在新窗口中显示」的持久化。
 *
 * File: <userData>/right-sidebar-window-settings.json
 *
 * 两个字段语义不同但同生命周期、同读写方(都只由 main 的 RsbWindowController 写),
 * 所以放同一文件:
 *  - detached: **偏好**(default false)。用户显式选择「侧边栏在新窗口打开」;
 *    走 override 模型(未自定义时跟随版本默认值,见 docs/dev-rules/configuration-and-overrides.md)。
 *  - lastOpen: **状态**(default false)。退出时子窗口是否处于打开态,供下次启动
 *    恢复(detached && lastOpen → 主窗 mount 后自动重开子窗口)。不经 Settings UI。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('right-sidebar-window-settings-store');

export interface RsbWindowSettings {
  detached: boolean;
  lastOpen: boolean;
}

const DEFAULTS: RsbWindowSettings = {
  detached: false,
  lastOpen: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'right-sidebar-window-settings.json');
}

export function normalizeRsbWindowSettings(raw: unknown): RsbWindowSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    detached: typeof r.detached === 'boolean' ? r.detached : DEFAULTS.detached,
    lastOpen: typeof r.lastOpen === 'boolean' ? r.lastOpen : DEFAULTS.lastOpen,
  };
}

const store = createOverrideSettingsFile<RsbWindowSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize: normalizeRsbWindowSettings,
  log,
  label: 'right-sidebar-window',
});

export function readRsbWindowSettings(): RsbWindowSettings {
  return store.read();
}

export function writeRsbWindowSettingsPatch(patch: Partial<RsbWindowSettings>): void {
  store.writePatch(patch);
}
