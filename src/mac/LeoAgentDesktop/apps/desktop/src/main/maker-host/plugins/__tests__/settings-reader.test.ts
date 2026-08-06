/**
 * Unit tests for SettingsReader — project plugin preference IO.
 *
 * Coverage:
 *   - Read valid project settings JSON (builtinTools key)
 *   - Tolerate bad JSON / wrong shape → empty
 *   - Missing file → null
 *   - Write + read round-trip
 *   - Cache invalidation on mtime change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SettingsReader } from '../settings-reader.js';
import { createBuiltinPlugins } from '../builtin-plugins.js';
import type { PluginId } from '../types.js';

function makeLogger() {
  return { warn: vi.fn() };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-plugin-test-'));
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeProjectSettings(workingDir: string, builtinTools: Record<string, boolean>) {
  const obj = {
    xdtMaker: {
      builtinTools: Object.fromEntries(
        Object.entries(builtinTools).map(([id, enabled]) => [id, { enabled }]),
      ),
    },
  };
  const settingsDir = path.join(workingDir, '.claude');
  writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify(obj, null, 2));
}

describe('SettingsReader — project settings', () => {
  let workingDir: string;
  let reader: SettingsReader;
  const logger = makeLogger();

  beforeEach(() => {
    workingDir = tmpDir();
    reader = new SettingsReader({ logger, userDataPath: workingDir });
  });

  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  it('returns null when .claude/settings.json does not exist', () => {
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
  });

  it('reads a project-level plugin override', () => {
    writeProjectSettings(workingDir, { ssh: false });
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);
  });

  it('returns null for plugin id not in project settings', () => {
    writeProjectSettings(workingDir, { ssh: false });
    expect(reader.readProjectPluginSetting(workingDir, 'feishu')).toBeNull();
  });

  it('tolerates malformed project settings JSON', () => {
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(path.join(settingsDir, 'settings.json'), '{broken');
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('tolerates missing xdtMaker key in settings.json', () => {
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({ other: 1 }));
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
  });

  it('falls back to legacy xdtMaker.plugins key when builtinTools is absent', () => {
    // round 1 (round 2 rename) 之前持久化的项目仍能被读到 — 走 settings-reader
    // 内的 fallback 链 (builtinTools ?? plugins)。
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ xdtMaker: { plugins: { ssh: { enabled: false } } } }),
    );
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);
  });

  it('prefers builtinTools over legacy plugins when both keys exist', () => {
    // 防御性 test: 用户手动同时填了两个 key 时, 新 key 是 source of truth。
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        xdtMaker: {
          builtinTools: { ssh: { enabled: true } },
          plugins: { ssh: { enabled: false } },
        },
      }),
    );
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(true);
  });

  it('readAllProjectOverrides returns all values', () => {
    writeProjectSettings(workingDir, { ssh: false, scheduler: false });
    const all = reader.readAllProjectOverrides(workingDir);
    expect(all.get('ssh')).toBe(false);
    expect(all.get('scheduler')).toBe(false);
    expect(all.has('feishu')).toBe(false);
  });

  it('cache invalidates on mtime change (sync stat)', () => {
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');
    writeProjectSettings(workingDir, { ssh: false });
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);

    writeProjectSettings(workingDir, { ssh: true });
    // Deterministically advance mtime. Sub-ms back-to-back writes can share an
    // mtimeMs on fast filesystems, which previously made this test flaky.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(settingsPath, future, future);
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(true);
  });

  it('cache invalidates on content change even when mtime is unchanged (size guard)', () => {
    // Directly exercises the same-tick gap: pin both writes to an identical mtime
    // so the only differentiator is file size. Without the size guard the
    // mtime-only cache would return the stale value.
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');
    const pinned = new Date('2026-01-01T00:00:00Z');

    writeProjectSettings(workingDir, { ssh: false }); // "enabled": false  (5 bytes)
    fs.utimesSync(settingsPath, pinned, pinned);
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);

    writeProjectSettings(workingDir, { ssh: true }); // "enabled": true   (4 bytes)
    fs.utimesSync(settingsPath, pinned, pinned); // same mtime as the cached entry
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(true);
  });

  it('writeProjectPluginSetting round-trip', async () => {
    await reader.writeProjectPluginSetting(workingDir, 'ssh', false);
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);

    await reader.writeProjectPluginSetting(workingDir, 'ssh', true);
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(true);
  });

  it('writeProjectPluginSetting preserves explicit true overrides for default-disabled plugins', async () => {
    await reader.writeProjectPluginSetting(workingDir, 'computer', true);

    expect(reader.readProjectPluginSetting(workingDir, 'computer')).toBe(true);
  });

  it('writeGlobalPluginSetting round-trip', async () => {
    await reader.writeGlobalPluginSetting('computer', true);

    expect(reader.readGlobalPluginSetting('computer')).toBe(true);

    await reader.clearGlobalPluginSetting('computer');
    expect(reader.readGlobalPluginSetting('computer')).toBeNull();
  });

  it('clearProjectPluginSetting removes an explicit override', async () => {
    await reader.writeProjectPluginSetting(workingDir, 'ssh', false);
    await reader.writeProjectPluginSetting(workingDir, 'scheduler', false);

    await reader.clearProjectPluginSetting(workingDir, 'ssh');

    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
    expect(reader.readProjectPluginSetting(workingDir, 'scheduler')).toBe(false);
  });

  it('writeProjectPluginSetting preserves other settings keys', async () => {
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
      otherKey: 'value',
      xdtMaker: { existingTool: { enabled: false } },
    }));

    await reader.writeProjectPluginSetting(workingDir, 'ssh', false);

    const raw = fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.otherKey).toBe('value');
    expect(parsed.xdtMaker.existingTool.enabled).toBe(false);
    expect(parsed.xdtMaker.builtinTools.ssh.enabled).toBe(false);
  });

  it('clearProjectPluginSetting removes only the requested override', async () => {
    await reader.writeProjectPluginSetting(workingDir, 'ssh', false);
    await reader.writeProjectPluginSetting(workingDir, 'scheduler', false);
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);

    await reader.clearProjectPluginSetting(workingDir, 'ssh');

    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
    expect(reader.readProjectPluginSetting(workingDir, 'scheduler')).toBe(false);
  });

  it('clearProjectPluginSetting also removes legacy plugin overrides', async () => {
    const settingsDir = path.join(workingDir, '.claude');
    writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        xdtMaker: {
          plugins: {
            ssh: { enabled: false },
            scheduler: { enabled: false },
          },
        },
      }),
    );
    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBe(false);

    await reader.clearProjectPluginSetting(workingDir, 'ssh');

    expect(reader.readProjectPluginSetting(workingDir, 'ssh')).toBeNull();
    expect(reader.readProjectPluginSetting(workingDir, 'scheduler')).toBe(false);
  });
});

describe('SettingsReader — known plugin IDs', () => {
  let workingDir: string;
  const logger = makeLogger();

  beforeEach(() => {
    workingDir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  const allBuiltinIds: PluginId[] = createBuiltinPlugins().map((plugin) => plugin.id);

  it('each builtin plugin id can be read via project settings', () => {
    const reader = new SettingsReader({ logger });
    writeProjectSettings(
      workingDir,
      Object.fromEntries(allBuiltinIds.map((id) => [id, false])),
    );

    for (const id of allBuiltinIds) {
      expect(reader.readProjectPluginSetting(workingDir, id)).toBe(false);
    }
  });
});
