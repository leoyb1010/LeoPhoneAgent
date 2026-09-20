import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { sanitizeBranchName, switchSessionBranch } from './session-branch.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机仓库能开新分支也能切回去，穿越目录会被拦', async () => {
  assert.equal(sanitizeBranchName('feat/登录'), 'feat/登录');
  await assert.rejects(() => switchSessionBranch('/', 'x'), /不能开分支/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-branch-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);
    const start = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const created = await switchSessionBranch(dir, 'feat/登录');
    assert.equal(created.branch, 'feat/登录');
    assert.equal(created.created, true);
    const onFeat = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(onFeat, 'feat/登录');
    const back = await switchSessionBranch(dir, start);
    assert.equal(back.branch, start);
    assert.equal(back.created, false);
    const again = await switchSessionBranch(dir, 'feat/登录');
    assert.equal(again.created, false);
    assert.equal(again.branch, 'feat/登录');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 branch', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/branch/);
  assert.match(routes, /switchSessionBranch/);
});
