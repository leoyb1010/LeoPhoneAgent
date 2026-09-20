import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { mergeSessionBranch } from './session-merge.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机仓库能把分支并回来，冲突会收掉，穿越目录会被拦', async () => {
  await assert.rejects(() => mergeSessionBranch('/', 'feat/登录'), /不能并分支/);
  await assert.rejects(() => mergeSessionBranch(os.tmpdir(), '   '), /写要并过来的分支/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-merge-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(path.join(dir, 'a.txt'), 'base\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'base']);
    const start = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    git(dir, ['switch', '-c', 'feat/登录']);
    await fsp.writeFile(path.join(dir, 'a.txt'), 'feature\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'feat']);
    git(dir, ['switch', start]);
    const merged = await mergeSessionBranch(dir, 'feat/登录');
    assert.equal(merged.from, 'feat/登录');
    assert.equal(merged.into, start);
    assert.equal(merged.already, false);
    assert.equal(await fsp.readFile(path.join(dir, 'a.txt'), 'utf8'), 'feature\n');
    const again = await mergeSessionBranch(dir, 'feat/登录');
    assert.equal(again.already, true);
    await assert.rejects(() => mergeSessionBranch(dir, start), /已经在这条分支上/);
    await assert.rejects(() => mergeSessionBranch(dir, 'missing/x'), /没有这条分支/);

    git(dir, ['switch', '-c', 'feat/冲突']);
    await fsp.writeFile(path.join(dir, 'a.txt'), 'left\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'left']);
    git(dir, ['switch', start]);
    await fsp.writeFile(path.join(dir, 'a.txt'), 'right\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'right']);
    await assert.rejects(() => mergeSessionBranch(dir, 'feat/冲突'), /有冲突|并不过去/);
    const merging = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(merging.status, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 merge', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/merge/);
  assert.match(routes, /mergeSessionBranch/);
});
