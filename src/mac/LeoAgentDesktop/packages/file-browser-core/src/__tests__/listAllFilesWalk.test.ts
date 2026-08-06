/**
 * listAllFilesWalk —— 无 rg 的纯 JS fallback 清单。
 * 覆盖:gitignore + BUILTIN_IGNORE 过滤、隐藏文件包含、cap 截断、symlink 跳过。
 */

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listAllFilesWalk } from '../listAllFiles.js';
import { __clearCacheForTesting } from '../ignore.js';

describe('listAllFilesWalk', () => {
  let workdir: string;

  beforeEach(async () => {
    __clearCacheForTesting();
    workdir = await mkdtemp(path.join(os.tmpdir(), 'walk-test-'));
    await writeFile(path.join(workdir, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8');
    await mkdir(path.join(workdir, 'src', 'deep'), { recursive: true });
    await mkdir(path.join(workdir, 'ignored-dir'));
    await mkdir(path.join(workdir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workdir, 'README.md'), '# hi\n', 'utf8');
    await writeFile(path.join(workdir, '.hidden.txt'), 'dot\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'a.ts'), 'a\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'deep', 'b.ts'), 'b\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'noise.log'), 'log\n', 'utf8');
    await writeFile(path.join(workdir, 'ignored-dir', 'x.txt'), 'x\n', 'utf8');
    await writeFile(path.join(workdir, 'node_modules', 'pkg', 'index.js'), 'm\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('honors gitignore + builtin ignore, includes dotfiles, recurses', async () => {
    const res = await listAllFilesWalk({ workdir });
    expect(res.truncated).toBe(false);
    expect(res.files).toEqual(
      expect.arrayContaining(['README.md', '.hidden.txt', 'src/a.ts', 'src/deep/b.ts']),
    );
    // .gitignore:目录与 glob 都生效;BUILTIN_IGNORE:node_modules 永不遍历。
    expect(res.files.some((f) => f.startsWith('ignored-dir/'))).toBe(false);
    expect(res.files).not.toContain('src/noise.log');
    expect(res.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('caps and marks truncated', async () => {
    const res = await listAllFilesWalk({ workdir, cap: 2 });
    expect(res.truncated).toBe(true);
    expect(res.files.length).toBe(2);
  });

  it('skips symlinks (no follow, no loops)', async () => {
    // 指回 workdir 自身的目录链接:follow 会造环,必须跳过。
    // 'junction':Windows 无特权也能建目录链接(POSIX 下该参数被忽略,行为不变)。
    await symlink(workdir, path.join(workdir, 'src', 'loop'), 'junction');
    const res = await listAllFilesWalk({ workdir });
    expect(res.truncated).toBe(false);
    expect(res.files.some((f) => f.includes('loop'))).toBe(false);
  });
});
