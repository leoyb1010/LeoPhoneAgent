import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applySessionPatch, patchTargetPaths } from './session-apply.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('补丁路径不能逃出会话目录', () => {
  assert.deepEqual(patchTargetPaths('+++ b/src/a.ts\n+++ /dev/null\n'), ['src/a.ts']);
  assert.deepEqual(patchTargetPaths('+++ b/../etc/passwd\n'), ['../etc/passwd']);
});

test('本机仓库能贴上 unified diff，穿越路径被拦', async () => {
  await assert.rejects(() => applySessionPatch('/', '+++ b/x\n'), /不能贴补丁/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-apply-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);

    const bad = '--- a/../secret\n+++ b/../secret\n@@ -1 +1 @@\n-x\n+y\n';
    await assert.rejects(() => applySessionPatch(dir, bad), /写出这个目录/);

    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+two',
      '',
    ].join('\n');
    const applied = await applySessionPatch(dir, patch);
    assert.deepEqual(applied.files, ['a.txt']);
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
