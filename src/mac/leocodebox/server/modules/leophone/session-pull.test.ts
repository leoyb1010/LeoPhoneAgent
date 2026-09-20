import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pullSessionRepo } from './session-pull.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机仓库能快进拉回远端，分叉了不会强行合并', async () => {
  await assert.rejects(() => pullSessionRepo('/'), /不能拉/);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-pull-'));
  const a = path.join(parent, 'a');
  const b = path.join(parent, 'b');
  const bare = path.join(parent, 'remote.git');
  try {
    await fs.mkdir(a);
    git(a, ['init']);
    git(a, ['config', 'user.email', 'test@example.com']);
    git(a, ['config', 'user.name', 'test']);
    git(a, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(a, 'a.txt'), 'one\n');
    git(a, ['add', 'a.txt']);
    git(a, ['commit', '-m', 'init']);
    await assert.rejects(() => pullSessionRepo(a), /还没有远端/);

    git(parent, ['init', '--bare', bare]);
    git(a, ['remote', 'add', 'origin', bare]);
    git(a, ['push', '-u', 'origin', 'HEAD']);
    git(parent, ['clone', bare, b]);
    git(b, ['config', 'user.email', 'test@example.com']);
    git(b, ['config', 'user.name', 'test']);
    git(b, ['config', 'commit.gpgsign', 'false']);

    await fs.writeFile(path.join(a, 'a.txt'), 'two\n');
    git(a, ['add', 'a.txt']);
    git(a, ['commit', '-m', 'ahead']);
    git(a, ['push']);

    const first = await pullSessionRepo(b);
    assert.equal(first.changed, true);
    assert.equal(await fs.readFile(path.join(b, 'a.txt'), 'utf8'), 'two\n');

    const again = await pullSessionRepo(b);
    assert.equal(again.changed, false);

    await fs.writeFile(path.join(b, 'a.txt'), 'bee\n');
    git(b, ['add', 'a.txt']);
    git(b, ['commit', '-m', 'bee']);
    await fs.writeFile(path.join(a, 'a.txt'), 'aye\n');
    git(a, ['add', 'a.txt']);
    git(a, ['commit', '-m', 'aye']);
    git(a, ['push']);
    await assert.rejects(() => pullSessionRepo(b), /不强制合并/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
