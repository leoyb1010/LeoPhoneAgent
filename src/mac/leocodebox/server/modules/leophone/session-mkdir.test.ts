import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { mkdirSessionFolder, sanitizeFolderRel } from './session-mkdir.js';

test('会话目录里能建文件夹，穿越和已有的会拦', async () => {
  assert.equal(sanitizeFolderRel('notes/草稿'), 'notes/草稿');
  await assert.rejects(() => mkdirSessionFolder('/', 'a'), /不能建文件夹/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-mkdir-'));
  try {
    const first = await mkdirSessionFolder(dir, 'notes/草稿');
    assert.equal(first.folder, 'notes/草稿');
    assert.equal((await fsp.stat(first.path)).isDirectory(), true);
    await assert.rejects(() => mkdirSessionFolder(dir, 'notes/草稿'), /已经有这个文件夹/);
    await fsp.writeFile(path.join(dir, 'taken'), 'x');
    await assert.rejects(() => mkdirSessionFolder(dir, 'taken'), /已经有这个名字/);
    const escaped = await mkdirSessionFolder(dir, '../escape');
    assert.equal(escaped.folder, 'escape');
    assert.equal(await fsp.realpath(path.dirname(escaped.path)), await fsp.realpath(dir));
    await assert.rejects(() => fsp.access(path.resolve(dir, '..', 'escape')));
    await assert.rejects(() => mkdirSessionFolder(dir, '.git'), /git/);
    const blank = await mkdirSessionFolder(dir, '');
    assert.equal(blank.folder, 'leo-新建');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 mkdir', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/mkdir/);
  assert.match(routes, /mkdirSessionFolder/);
});
