import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { listDirtySessionFiles, packSessionChanges, sanitizePackName } from './session-pack.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('打包文件名只落在会话目录里', () => {
  assert.equal(sanitizePackName('修 登录'), '修-登录.zip');
  assert.equal(sanitizePackName('../etc/passwd'), 'passwd.zip');
});

test('本机仓库能把改过的文件打成一份，穿越路径被拦', async () => {
  await assert.rejects(() => packSessionChanges('/', { files: ['a.txt'] }), /不能打包/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-pack-'));
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

    const dirty = await listDirtySessionFiles(dir);
    assert.ok(dirty.includes('kept.txt'));
    assert.ok(dirty.includes('fresh.txt'));

    await assert.rejects(() => packSessionChanges(dir, { files: ['../secret'] }), /会话目录/);
    const packed = await packSessionChanges(dir, { name: 'leo-改动.zip' });
    assert.equal(packed.name, 'leo-改动.zip');
    assert.equal(await fs.realpath(path.dirname(packed.path)), await fs.realpath(dir));
    const listed = spawnSync('/usr/bin/zipinfo', ['-1', packed.path], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /kept.txt/);
    assert.match(listed.stdout, /fresh.txt/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
