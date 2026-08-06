/**
 * legacyDeadDirs.test.ts — 历史兼容层死目录清退单测。
 * os.tmpdir 注入根目录(规则 23)。覆盖:名单封闭性(不认识的目录名一律拒)、
 * 30 天资格判定(有新文件即整目录不合格)、clean 前重新核验、空目录壳可清退。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/never-used-in-these-tests' },
}));

const deadDirs = await import('../legacyDeadDirs');

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dead-dirs-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const OLD_DATE = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

function seedDir(name: string, files: Array<{ rel: string; old: boolean }>): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const abs = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    if (f.old) fs.utimesSync(abs, OLD_DATE, OLD_DATE);
  }
}

describe('scanDeadDirs(报数与资格)', () => {
  it('全部文件超 30 天 → eligible;有一个新文件 → 整目录不合格;不存在 → exists=false', async () => {
    seedDir('@cindy/image-media', [
      { rel: 'a.png', old: true },
      { rel: 'sub/b.png', old: true },
    ]);
    seedDir('mivo-media', [
      { rel: 'old.mp3', old: true },
      { rel: 'new.mp3', old: false }, // 新文件:说明"零引用"结论过期,拒绝
    ]);

    const statuses = await deadDirs.scanDeadDirs(root);
    const byName = new Map(statuses.map((s) => [s.name, s]));
    expect(byName.get('@cindy/image-media')).toMatchObject({
      exists: true,
      fileCount: 2,
      eligible: true,
    });
    expect(byName.get('mivo-media')).toMatchObject({ exists: true, eligible: false });
    expect(byName.get('mivo')).toMatchObject({ exists: false, eligible: false });
  });

  it('空目录壳本身就是滞留物,可清退', async () => {
    fs.mkdirSync(path.join(root, 'mivo'));
    const statuses = await deadDirs.scanDeadDirs(root);
    expect(statuses.find((s) => s.name === 'mivo')).toMatchObject({
      exists: true,
      fileCount: 0,
      eligible: true,
    });
  });
});

describe('cleanDeadDirs(清退与封闭名单)', () => {
  it('只清名单内且复验合格的;名单外目录名一律拒(不给删任意子目录留口)', async () => {
    seedDir('@cindy/image-media', [{ rel: 'a.png', old: true }]);
    seedDir('feishu-media', [{ rel: 'in-use.png', old: true }]); // 在用目录,不在名单

    const result = await deadDirs.cleanDeadDirs(
      ['@cindy/image-media', 'feishu-media', '../escape'],
      root,
    );
    expect(result.removed).toEqual(['@cindy/image-media']);
    expect(result.skipped).toEqual(expect.arrayContaining(['feishu-media', '../escape']));
    expect(fs.existsSync(path.join(root, '@cindy/image-media'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'feishu-media'))).toBe(true);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it('报数与确认之间出现新文件 → 复验不合格,拒绝删除', async () => {
    seedDir('mivo-media', [{ rel: 'old.mp3', old: true }]);
    // 确认前有新写入(理论上不该发生,发生了就说明结论过期)。
    fs.writeFileSync(path.join(root, 'mivo-media', 'fresh.mp3'), 'x');
    const result = await deadDirs.cleanDeadDirs(['mivo-media'], root);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(['mivo-media']);
    expect(fs.existsSync(path.join(root, 'mivo-media'))).toBe(true);
  });
});
