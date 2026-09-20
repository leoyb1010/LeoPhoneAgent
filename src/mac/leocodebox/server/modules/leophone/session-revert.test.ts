import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveSessionFile, revertPlanFromPorcelain, revertSessionFile } from './session-revert.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('porcelain：没改动 / 未跟踪 / 已改', () => {
  assert.equal(revertPlanFromPorcelain(''), 'none');
  assert.equal(revertPlanFromPorcelain('?? new.txt'), 'remove');
  assert.equal(revertPlanFromPorcelain(' M src/a.ts'), 'restore');
  assert.equal(revertPlanFromPorcelain('M  src/a.ts'), 'restore');
});

test('只能还原会话目录里的文件，拦穿越', () => {
  const root = '/tmp/leo-revert-work';
  assert.equal(resolveSessionFile(root, 'src/a.ts').rel, path.join('src', 'a.ts'));
  assert.throws(() => resolveSessionFile(root, '../etc/passwd'), /会话目录/);
  assert.throws(() => resolveSessionFile('/', 'tmp/x'), /不能还原/);
  assert.throws(() => resolveSessionFile(root, '  '), /没有要还原/);
});

test('git 仓库：改过的文件还原，新建的文件删掉', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-revert-'));
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

    const restored = await revertSessionFile(dir, 'kept.txt');
    assert.equal(restored.action, 'restored');
    assert.equal(await fs.readFile(path.join(dir, 'kept.txt'), 'utf8'), 'hello\n');

    const removed = await revertSessionFile(dir, 'fresh.txt');
    assert.equal(removed.action, 'removed');
    assert.equal(await fs.stat(path.join(dir, 'fresh.txt')).catch(() => null), null);

    await assert.rejects(() => revertSessionFile(dir, 'kept.txt'), /没有可还原/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有 git 就诚实说没法还原', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-nogit-'));
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    await assert.rejects(() => revertSessionFile(dir, 'a.txt'), /没有 git/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
