import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { duplicateSessionFile, nextDuplicateName } from './session-duplicate.js';

test('会话目录里的文件能复制一份，穿越和文件夹会拦', async () => {
  assert.equal(nextDuplicateName('notes/a.md'), 'notes/a-副本.md');
  await assert.rejects(() => duplicateSessionFile('/', 'a.txt'), /不能复制文件/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-dup-'));
  try {
    await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes', 'a.md'), 'keep\n');
    await fsp.mkdir(path.join(dir, 'keep'));
    const first = await duplicateSessionFile(dir, 'notes/a.md');
    assert.equal(first.file, 'notes/a-副本.md');
    assert.equal(await fsp.readFile(path.join(dir, 'notes', 'a-副本.md'), 'utf8'), 'keep\n');
    const second = await duplicateSessionFile(dir, 'notes/a.md');
    assert.equal(second.file, 'notes/a-副本-2.md');
    await assert.rejects(() => duplicateSessionFile(dir, 'keep'), /文件夹/);
    await assert.rejects(() => duplicateSessionFile(dir, '../escape.txt'), /只能复制/);
    await assert.rejects(() => duplicateSessionFile(dir, '.git/config'), /git/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 duplicate', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/duplicate/);
  assert.match(routes, /duplicateSessionFile/);
});
