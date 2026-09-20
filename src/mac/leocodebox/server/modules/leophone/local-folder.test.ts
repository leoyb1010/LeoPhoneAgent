import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openRevealArgs, pickLocalFolder, resolveRevealablePath, revealLocalPath } from './local-folder.js';

test('系统目录和根盘不能打开', () => {
  assert.throws(() => resolveRevealablePath('/etc/passwd'), /不能打开/);
  assert.throws(() => resolveRevealablePath('/'), /不能打开/);
  assert.ok(resolveRevealablePath('~/Documents').startsWith(os.homedir()));
});

test('目录用 open,文件用 open -R', () => {
  assert.deepEqual(openRevealArgs('/tmp/proj', true), ['/tmp/proj']);
  assert.deepEqual(openRevealArgs('/tmp/proj/a.ts', false), ['-R', '/tmp/proj/a.ts']);
});

test('选目录取消不算失败,选中的路径会展开并拦系统目录', async () => {
  const cancelled = await pickLocalFolder(async () => ({ stdout: '', stderr: 'User canceled.', code: 1 }));
  assert.deepEqual(cancelled, { cancelled: true });
  const picked = await pickLocalFolder(async () => ({ stdout: `${os.homedir()}/Documents/\n`, stderr: '', code: 0 }));
  assert.ok('path' in picked);
  assert.equal(picked.path, path.join(os.homedir(), 'Documents'));
  await assert.rejects(
    pickLocalFolder(async () => ({ stdout: '/etc/\n', stderr: '', code: 0 })),
    /不能打开/,
  );
});

test('揭示会先确认路径存在再调 open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-folder-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'x');
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { stdout: '', stderr: '', code: 0 };
  };
  assert.deepEqual(await revealLocalPath(dir, run), { path: dir });
  assert.deepEqual(await revealLocalPath(file, run), { path: file });
  assert.deepEqual(calls[0], { command: '/usr/bin/open', args: [dir] });
  assert.deepEqual(calls[1], { command: '/usr/bin/open', args: ['-R', file] });
  await assert.rejects(revealLocalPath(path.join(dir, 'missing'), run), /不存在/);
});
