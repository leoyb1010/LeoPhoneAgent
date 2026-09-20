import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clipCommitMessage, commitSessionFiles } from './session-commit.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('提交说明压成一行，空的要自己写', () => {
  assert.equal(clipCommitMessage('  改了\n两行  '), '改了 两行');
  assert.equal(clipCommitMessage('x'.repeat(240)).length, 200);
  assert.equal(clipCommitMessage(' \n '), '');
});

test('git 仓库：列出的改动能一笔记下，干净文件拒绝', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-commit-'));
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

    const row = await commitSessionFiles(dir, { message: '记下这次改动', files: ['kept.txt', 'fresh.txt'] });
    assert.equal(row.message, '记下这次改动');
    assert.equal(row.files.length, 2);
    assert.match(row.hash, /^[0-9a-f]{4,}$/);
    assert.equal(await fs.readFile(path.join(dir, 'kept.txt'), 'utf8'), 'changed\n');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    assert.equal(status.stdout.trim(), '');

    await assert.rejects(() => commitSessionFiles(dir, { message: '再记一次', files: ['kept.txt'] }), /没有可记下/);
    await assert.rejects(() => commitSessionFiles(dir, { message: '', files: ['kept.txt'] }), /写一句/);
    await assert.rejects(() => commitSessionFiles(dir, { message: 'ok', files: ['../etc/passwd'] }), /会话目录/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有 git 就诚实说没法记下', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-nocommit-'));
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    await assert.rejects(() => commitSessionFiles(dir, { message: '记下', files: ['a.txt'] }), /没有 git/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
