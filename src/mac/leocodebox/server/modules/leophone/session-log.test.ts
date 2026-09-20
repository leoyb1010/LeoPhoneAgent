import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isCommitHash, listSessionCommits, parseGitLogLine, showSessionCommit } from './session-log.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('解析 log 行，拦坏 hash 和系统目录', () => {
  assert.deepEqual(parseGitLogLine('abc1234\t1710000000\t修登录'), { hash: 'abc1234', subject: '修登录', at: 1710000000 * 1000 });
  assert.equal(parseGitLogLine('not a hash'), null);
  assert.equal(isCommitHash('../HEAD'), false);
});

test('本机仓库能列出最近提交并点开那一次', async () => {
  await assert.rejects(() => listSessionCommits('/'), /不能看提交/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-log-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', '第一次']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', '第二次']);

    const listed = await listSessionCommits(dir);
    assert.equal(listed.commits.length, 2);
    assert.equal(listed.commits[0]?.subject, '第二次');
    const shown = await showSessionCommit(dir, listed.commits[0]!.hash);
    assert.match(shown.patch, /第二次|two/);
    await assert.rejects(() => showSessionCommit(dir, '../HEAD'), /不合法/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
