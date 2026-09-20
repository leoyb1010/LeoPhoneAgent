import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clipSessionDiff, diffSessionFile, looksBinaryDiff } from './session-diff.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('补丁裁剪和二进制判断', () => {
  assert.equal(looksBinaryDiff('Binary files a and b differ'), true);
  assert.equal(looksBinaryDiff('diff --git a/x b/x\n+ok'), false);
  assert.ok(clipSessionDiff('x'.repeat(90_000)).includes('后面还有'));
});

test('git 仓库：改过的和新建的都能看出补丁，干净的诚实说', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-diff-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(dir, 'kept.txt'), 'hello\n');
    git(dir, ['add', 'kept.txt']);
    git(dir, ['commit', '-m', 'init']);
    await fs.writeFile(path.join(dir, 'kept.txt'), 'changed\n');
    await fs.writeFile(path.join(dir, 'fresh.txt'), 'new\n');

    const modified = await diffSessionFile(dir, 'kept.txt');
    assert.equal(modified.kind, 'modified');
    assert.match(modified.patch, /changed/);
    assert.match(modified.patch, /hello/);

    const added = await diffSessionFile(dir, 'fresh.txt');
    assert.equal(added.kind, 'added');
    assert.match(added.patch, /new/);

    git(dir, ['checkout', '--', 'kept.txt']);
    const clean = await diffSessionFile(dir, 'kept.txt');
    assert.equal(clean.kind, 'clean');
    assert.match(clean.patch, /没有可看的改动/);

    await assert.rejects(() => diffSessionFile(dir, '../etc/passwd'), /会话目录/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有 git 就诚实说没法看改动', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-nodiff-'));
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    await assert.rejects(() => diffSessionFile(dir, 'a.txt'), /没有 git/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
