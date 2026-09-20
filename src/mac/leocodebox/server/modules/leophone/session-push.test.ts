import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pushSessionRepo } from './session-push.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机仓库能推到自己的远端，没有远端或穿越目录会被拦', async () => {
  await assert.rejects(() => pushSessionRepo('/'), /不能推/);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-push-'));
  const repo = path.join(parent, 'work');
  const bare = path.join(parent, 'remote.git');
  try {
    await fs.mkdir(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'init']);
    await assert.rejects(() => pushSessionRepo(repo), /还没有远端/);

    git(parent, ['init', '--bare', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    const first = await pushSessionRepo(repo);
    assert.equal(first.remote, 'origin');
    assert.ok(first.branch);
    const log = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: bare, encoding: 'utf8' });
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /init/);

    await fs.writeFile(path.join(repo, 'a.txt'), 'two\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'again']);
    const second = await pushSessionRepo(repo);
    assert.equal(second.remote, 'origin');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
