/**
 * git-context/headReader 单测 — 真实 fs tmpdir fixture,覆盖:
 *   - 普通 checkout(.git 目录)分支解析
 *   - linked worktree(.git 文件 gitdir 间接,绝对/相对路径)
 *   - detached HEAD(裸 sha)
 *   - 子目录向上查找、非 git 目录、异常 HEAD 内容
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseHeadContent,
  readGitHead,
  resolveHeadLocation,
} from '../git-context/headReader';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-context-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个最小普通 checkout:<dir>/.git/HEAD */
function makeRepo(dir: string, headContent: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), headContent);
}

describe('parseHeadContent', () => {
  it('解析分支 ref', () => {
    expect(parseHeadContent('ref: refs/heads/main\n')).toEqual({
      kind: 'branch',
      branch: 'main',
      shortSha: null,
    });
  });

  it('解析带斜杠的分支名', () => {
    expect(parseHeadContent('ref: refs/heads/feat/session-git-pr-context\n')).toEqual({
      kind: 'branch',
      branch: 'feat/session-git-pr-context',
      shortSha: null,
    });
  });

  it('解析 detached HEAD(裸 40 位 sha)', () => {
    const sha = 'a'.repeat(40);
    expect(parseHeadContent(`${sha}\n`)).toEqual({
      kind: 'detached',
      branch: null,
      shortSha: 'aaaaaaaa',
    });
  });

  it('非法内容返回 null(refs/tags、空串、半截 sha)', () => {
    expect(parseHeadContent('ref: refs/tags/v1.0.0\n')).toBeNull();
    expect(parseHeadContent('')).toBeNull();
    expect(parseHeadContent('abc123\n')).toBeNull();
  });
});

describe('resolveHeadLocation / readGitHead', () => {
  it('普通 checkout:.git 目录直读 HEAD', async () => {
    makeRepo(tmpRoot, 'ref: refs/heads/main\n');
    const head = await readGitHead(tmpRoot);
    expect(head).toEqual({ kind: 'branch', branch: 'main', shortSha: null });
  });

  it('从子目录向上查找 .git', async () => {
    makeRepo(tmpRoot, 'ref: refs/heads/dev\n');
    const nested = path.join(tmpRoot, 'src', 'deep', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    const head = await readGitHead(nested);
    expect(head?.branch).toBe('dev');
  });

  it('linked worktree:.git 文件 gitdir 绝对路径间接', async () => {
    // 主仓 + worktrees/<name>/HEAD
    const mainRepo = path.join(tmpRoot, 'main-repo');
    makeRepo(mainRepo, 'ref: refs/heads/main\n');
    const wtGitDir = path.join(mainRepo, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feat/x\n');
    // worktree checkout 目录:.git 是文件
    const wtDir = path.join(tmpRoot, 'wt-checkout');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${wtGitDir}\n`);

    const loc = await resolveHeadLocation(wtDir);
    expect(loc?.headPath).toBe(path.join(wtGitDir, 'HEAD'));
    const head = await readGitHead(wtDir);
    expect(head?.branch).toBe('feat/x');
  });

  it('linked worktree:gitdir 相对路径以 .git 文件所在目录为基准', async () => {
    const wtGitDir = path.join(tmpRoot, 'gitmeta');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/rel\n');
    const wtDir = path.join(tmpRoot, 'checkout');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: ../gitmeta\n');

    const head = await readGitHead(wtDir);
    expect(head?.branch).toBe('rel');
  });

  it('非 git 目录返回 null', async () => {
    expect(await resolveHeadLocation(tmpRoot)).toBeNull();
    expect(await readGitHead(tmpRoot)).toBeNull();
  });

  it('HEAD 文件缺失返回 null', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
    expect(await readGitHead(tmpRoot)).toBeNull();
  });
});
