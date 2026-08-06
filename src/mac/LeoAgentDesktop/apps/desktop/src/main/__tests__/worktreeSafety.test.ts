/**
 * worktree-parallel-sessions: isManagedWorktreePath 三条校验单测。
 *
 * 关键安全门: 任一条件不满足都必须返回 false, 防止 fs.rm 越权。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { isManagedWorktreePath } from '../worktree/safety';

describe('isManagedWorktreePath', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let managedRoot: string;
  let legacyManagedRoot: string;
  let validPath: string;
  let symlinkPath: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-safety-'));
    baseRepo = path.join(tmpRoot, 'repo');
    managedRoot = path.join(baseRepo, '.cindy-worktrees');
    legacyManagedRoot = path.join(baseRepo, '.xdt-worktrees');
    validPath = path.join(managedRoot, 'jolly-turing');
    fs.mkdirSync(validPath, { recursive: true });
    fs.mkdirSync(path.join(legacyManagedRoot, 'legacy-one'), { recursive: true });

    // 在托管目录下也建一个软链, 测试软链拒绝
    symlinkPath = path.join(managedRoot, 'evil-link');
    try {
      fs.symlinkSync(tmpRoot, symlinkPath, 'dir');
    } catch {
      // Windows 上没管理员权限可能创不了软链, 测试用例后面会判 stat 不存在 → 拒绝
    }
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns true when all three checks pass', () => {
    expect(isManagedWorktreePath(validPath, baseRepo, [validPath])).toBe(true);
  });

  it('keeps accepting legacy .xdt-worktrees paths for safe cleanup', () => {
    const legacyPath = path.join(legacyManagedRoot, 'legacy-one');
    expect(isManagedWorktreePath(legacyPath, baseRepo, [legacyPath])).toBe(true);
  });

  it('rejects when path is outside the managed worktree roots', () => {
    const outside = path.join(tmpRoot, 'totally-elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    expect(isManagedWorktreePath(outside, baseRepo, [outside])).toBe(false);
  });

  it('rejects when path uses ../ traversal to escape', () => {
    const traversal = path.join(managedRoot, 'jolly-turing', '..', '..', '..', 'tmp');
    expect(isManagedWorktreePath(traversal, baseRepo, [validPath])).toBe(false);
  });

  it('rejects when path is NOT in knownPathsInStore', () => {
    expect(isManagedWorktreePath(validPath, baseRepo, [])).toBe(false);
    const otherPath = path.join(managedRoot, 'someone-else');
    fs.mkdirSync(otherPath, { recursive: true });
    expect(isManagedWorktreePath(otherPath, baseRepo, [validPath])).toBe(false);
  });

  it('rejects when path is a symbolic link (if creatable)', () => {
    let linkExists = false;
    try {
      linkExists = fs.lstatSync(symlinkPath).isSymbolicLink();
    } catch {
      // 软链没建成 → 跳过(下面的 false 也是预期: 不存在 ⇒ 拒绝)
    }
    if (linkExists) {
      expect(isManagedWorktreePath(symlinkPath, baseRepo, [symlinkPath])).toBe(false);
    } else {
      // 软链没建出来, 至少验证 lstat 失败的路径被拒绝
      const fakePath = path.join(managedRoot, 'never-existed');
      expect(isManagedWorktreePath(fakePath, baseRepo, [fakePath])).toBe(false);
    }
  });

  it('rejects sibling directory that shares the managed prefix', () => {
    const sibling = path.join(baseRepo, '.cindy-worktrees-evil', 'foo');
    fs.mkdirSync(sibling, { recursive: true });
    expect(isManagedWorktreePath(sibling, baseRepo, [sibling])).toBe(false);
  });

  it('rejects when baseRepo itself is the target', () => {
    expect(isManagedWorktreePath(baseRepo, baseRepo, [baseRepo])).toBe(false);
  });
});
