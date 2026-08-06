import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';

import {
  buildLegacyDialogueRoots,
  healMissingDialogueWorkdir,
  matchDialogueWorkspacePath,
  sweepLegacyDialogueWorkingDirs,
  type DialogueSweepDb,
} from '../dialogueWorkdirSelfHeal';

const noopLog = { info: vi.fn(), warn: vi.fn() };

describe('matchDialogueWorkspacePath', () => {
  const root = path.join(path.sep, 'data', 'Cindy', 'dialogues');

  it('matches the app-managed <root>/<day>/<sessionId> shape', () => {
    const dir = path.join(root, '2026-06-22', '829cdef6-abc');
    expect(matchDialogueWorkspacePath(dir, root)).toEqual({
      dayKey: '2026-06-22',
      sessionIdSegment: '829cdef6-abc',
    });
  });

  it('matches forward-slash storage form paths against a platform-joined root', () => {
    // DB 存的是 storage 规范形(永远 forward slash);root 来自 path.join。
    const stored = `${root.split(path.sep).join('/')}/2026-06-22/cuid123`;
    expect(matchDialogueWorkspacePath(stored, root)).toEqual({
      dayKey: '2026-06-22',
      sessionIdSegment: 'cuid123',
    });
  });

  it('rejects paths outside the root, wrong depth, or bad day key', () => {
    expect(matchDialogueWorkspacePath(path.join(path.sep, 'other', '2026-06-22', 'x'), root)).toBeNull();
    expect(matchDialogueWorkspacePath(root, root)).toBeNull();
    expect(matchDialogueWorkspacePath(path.join(root, '2026-06-22'), root)).toBeNull();
    expect(matchDialogueWorkspacePath(path.join(root, '2026-06-22', 'x', 'deep'), root)).toBeNull();
    expect(matchDialogueWorkspacePath(path.join(root, 'not-a-day', 'x'), root)).toBeNull();
    expect(matchDialogueWorkspacePath(path.join(root, '..', 'dialogues2', '2026-06-22', 'x'), root)).toBeNull();
  });

  it('rejects blank inputs', () => {
    expect(matchDialogueWorkspacePath('', root)).toBeNull();
    expect(matchDialogueWorkspacePath(path.join(root, '2026-06-22', 'x'), '')).toBeNull();
  });
});

describe('buildLegacyDialogueRoots', () => {
  it('derives sibling legacy dialogues roots from current userData', () => {
    const userData = path.join(path.sep, 'data', 'Cindy');
    expect(buildLegacyDialogueRoots(userData, ['xdt-maker'])).toEqual([
      path.join(path.sep, 'data', 'xdt-maker', 'dialogues'),
    ]);
  });

  it('drops a legacy name identical to the current userData dir', () => {
    const userData = path.join(path.sep, 'data', 'Cindy');
    expect(buildLegacyDialogueRoots(userData, ['Cindy'])).toEqual([]);
  });
});

describe('healMissingDialogueWorkdir', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dialogue-heal-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('recreates a missing dialogue workdir under the current root', async () => {
    const dialoguesRoot = path.join(tmpRoot, 'dialogues');
    const dir = path.join(dialoguesRoot, '2026-06-22', 'sess-1');
    await expect(healMissingDialogueWorkdir(dir, dialoguesRoot)).resolves.toBe(true);
    await expect(fsp.stat(dir)).resolves.toMatchObject({});
  });

  it('refuses paths that are not app-managed dialogue workdirs', async () => {
    const dialoguesRoot = path.join(tmpRoot, 'dialogues');
    const userProject = path.join(tmpRoot, 'user-project');
    await expect(healMissingDialogueWorkdir(userProject, dialoguesRoot)).resolves.toBe(false);
    await expect(fsp.stat(userProject)).rejects.toThrow();
  });

  it('returns false when mkdir fails instead of throwing', async () => {
    const dialoguesRoot = path.join(tmpRoot, 'dialogues');
    const dir = path.join(dialoguesRoot, '2026-06-22', 'sess-1');
    await expect(
      healMissingDialogueWorkdir(dir, dialoguesRoot, {
        mkdirp: async () => {
          throw new Error('EACCES');
        },
      }),
    ).resolves.toBe(false);
  });
});

describe('sweepLegacyDialogueWorkingDirs', () => {
  // Windows 上用带盘符的真实绝对路径:storage 规范形只对 windows-path-like
  // 的输入做反斜杠归一(见 normalizeWorkingDirForStorage)。
  const isWin = process.platform === 'win32';
  const userData = isWin ? 'C:\\data\\Cindy' : '/data/Cindy';
  const legacyRootStored = isWin ? 'C:/data/xdt-maker/dialogues' : '/data/xdt-maker/dialogues';
  const currentRootStored = isWin ? 'C:/data/Cindy/dialogues' : '/data/Cindy/dialogues';

  function makeFakeDb(rows: Array<{ id: string; working_dir: string }>) {
    const execCalls: Array<{ sql: string; params: unknown[] }> = [];
    const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
    const db: DialogueSweepDb = {
      query: async <T,>(sql: string, params: unknown[] = []) => {
        queryCalls.push({ sql, params });
        return rows as T[];
      },
      exec: async (sql: string, params: unknown[] = []) => {
        execCalls.push({ sql, params });
        return { changes: 1, lastInsertRowid: 0 };
      },
    };
    return { db, execCalls, queryCalls };
  }

  /** 默认 fs 假体:磁盘上什么都不存在(老目录已消失场景,直接改写)。 */
  const noDiskFs = {
    pathExists: async () => false,
    copyDir: async () => {},
  };

  it('rewrites legacy dialogue paths to the current userData root', async () => {
    const { db, execCalls, queryCalls } = makeFakeDb([
      { id: 's1', working_dir: `${legacyRootStored}/2026-06-22/s1` },
      { id: 's2', working_dir: `${legacyRootStored}/2026-05-20/cuidzzz` },
    ]);
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: noopLog,
      ...noDiskFs,
    });

    expect(result).toMatchObject({ scanned: 2, rewritten: 2, deferred: 0 });
    expect(queryCalls[0].params).toEqual([`${legacyRootStored}/%`]);
    expect(queryCalls[0].sql).toContain('remote_host_id IS NULL');
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0].params).toEqual([`${currentRootStored}/2026-06-22/s1`, 's1']);
    expect(execCalls[1].params).toEqual([`${currentRootStored}/2026-05-20/cuidzzz`, 's2']);
  });

  it('skips LIKE over-matches whose shape is not an app-managed dialogue dir', async () => {
    const { db, execCalls } = makeFakeDb([
      // 深层子目录 / 非日期桶:LIKE 命中但形状不合法,必须跳过。
      { id: 's3', working_dir: `${legacyRootStored}/2026-06-22/s3/nested` },
      { id: 's4', working_dir: `${legacyRootStored}/not-a-day/s4` },
    ]);
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: noopLog,
      ...noDiskFs,
    });

    expect(result).toMatchObject({ scanned: 2, rewritten: 0, deferred: 0 });
    expect(execCalls).toHaveLength(0);
  });

  it('continues past per-row update failures', async () => {
    const rows = [
      { id: 's5', working_dir: `${legacyRootStored}/2026-06-22/s5` },
      { id: 's6', working_dir: `${legacyRootStored}/2026-06-22/s6` },
    ];
    let call = 0;
    const db: DialogueSweepDb = {
      query: async <T,>() => rows as T[],
      exec: async () => {
        call += 1;
        if (call === 1) throw new Error('disk I/O error');
        return { changes: 1, lastInsertRowid: 0 };
      },
    };
    const warn = vi.fn();
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: { info: vi.fn(), warn },
      ...noDiskFs,
    });

    expect(result).toMatchObject({ scanned: 2, rewritten: 1, deferred: 0 });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does nothing when there are no legacy roots', async () => {
    const { db, queryCalls } = makeFakeDb([]);
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['Cindy'],
      log: noopLog,
      ...noDiskFs,
    });
    expect(result).toMatchObject({ scanned: 0, rewritten: 0, deferred: 0 });
    expect(queryCalls).toHaveLength(0);
  });

  it('rewrites pre-owner-namespace dialogue paths into the scoped owner root', async () => {
    const oldRoot = path.join(userData, 'dialogues');
    const ownerRoot = path.join(userData, 'owners', 'owner-key', 'dialogues');
    const oldStored = normalizeWorkingDirForStorage(oldRoot)!;
    const ownerStored = normalizeWorkingDirForStorage(ownerRoot)!;
    const { db, execCalls, queryCalls } = makeFakeDb([
      { id: 'owner-session', working_dir: `${oldStored}/2026-07-22/owner-session` },
    ]);

    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['Cindy'],
      currentDialoguesRoot: ownerRoot,
      additionalLegacyDialogueRoots: [oldRoot],
      log: noopLog,
      ...noDiskFs,
    });

    expect(result).toMatchObject({ scanned: 1, rewritten: 1, deferred: 0 });
    expect(queryCalls).toHaveLength(1);
    expect(execCalls[0].params).toEqual([
      `${ownerStored}/2026-07-22/owner-session`,
      'owner-session',
    ]);
  });

  it('defers still-existing legacy dirs to background: copy then rewrite', async () => {
    const { db, execCalls } = makeFakeDb([
      { id: 's7', working_dir: `${legacyRootStored}/2026-06-22/s7` },
    ]);
    const copyCalls: Array<{ src: string; dest: string }> = [];
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: noopLog,
      // 老目录还在、新位置缺失 → 转后台先搬内容再改写。
      pathExists: async (p) => p === `${legacyRootStored}/2026-06-22/s7`,
      copyDir: async (src, dest) => {
        copyCalls.push({ src, dest });
      },
    });

    expect(result).toMatchObject({ scanned: 1, rewritten: 0, deferred: 1 });
    await expect(result.background).resolves.toEqual({ copied: 1, rewritten: 1 });
    expect(copyCalls).toEqual([
      { src: `${legacyRootStored}/2026-06-22/s7`, dest: `${currentRootStored}/2026-06-22/s7` },
    ]);
    expect(execCalls).toHaveLength(1);
  });

  it('resolves the sweep before background copies finish (does not block ensure-ready)', async () => {
    const { db, execCalls } = makeFakeDb([
      { id: 's7b', working_dir: `${legacyRootStored}/2026-06-22/s7b` },
    ]);
    let releaseCopy!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      releaseCopy = () => resolve();
    });
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: noopLog,
      pathExists: async (p) => p === `${legacyRootStored}/2026-06-22/s7b`,
      copyDir: async () => {
        await copyStarted;
      },
    });

    // sweep 已返回而复制仍挂起:同步阶段不含任何复制等待。
    expect(result).toMatchObject({ scanned: 1, rewritten: 0, deferred: 1 });
    expect(execCalls).toHaveLength(0);
    releaseCopy();
    await expect(result.background).resolves.toEqual({ copied: 1, rewritten: 1 });
    expect(execCalls).toHaveLength(1);
  });

  it('skips the row (no rewrite) when background copy fails, to retry next boot', async () => {
    const { db, execCalls } = makeFakeDb([
      { id: 's8', working_dir: `${legacyRootStored}/2026-06-22/s8` },
    ]);
    const warn = vi.fn();
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: { info: vi.fn(), warn },
      pathExists: async (p) => p === `${legacyRootStored}/2026-06-22/s8`,
      copyDir: async () => {
        throw new Error('EACCES');
      },
    });

    expect(result).toMatchObject({ scanned: 1, rewritten: 0, deferred: 1 });
    await expect(result.background).resolves.toEqual({ copied: 0, rewritten: 0 });
    expect(execCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rewrites without copying when the healed target already exists (mToc copied it)', async () => {
    const { db, execCalls } = makeFakeDb([
      { id: 's9', working_dir: `${legacyRootStored}/2026-06-22/s9` },
    ]);
    const copyDir = vi.fn();
    const result = await sweepLegacyDialogueWorkingDirs({
      db,
      userDataDir: userData,
      legacyUserDataDirNames: ['xdt-maker'],
      log: noopLog,
      pathExists: async (p) => p === `${currentRootStored}/2026-06-22/s9`,
      copyDir,
    });

    expect(result).toMatchObject({ scanned: 1, rewritten: 1, deferred: 0 });
    expect(copyDir).not.toHaveBeenCalled();
    expect(execCalls).toHaveLength(1);
  });
});
