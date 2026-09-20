import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { moveDestRel, moveSessionFile } from './session-move.js';

test('会话目录里的文件能挪进文件夹，穿越和盖住会拦', async () => {
  assert.equal(moveDestRel('notes/a.md', '草稿'), '草稿/a.md');
  await assert.rejects(() => moveSessionFile('/', 'a.txt', 'b'), /不能挪文件/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-move-'));
  try {
    await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes', 'a.md'), 'keep\n');
    await fsp.mkdir(path.join(dir, 'keep'));
    const first = await moveSessionFile(dir, 'notes/a.md', '草稿');
    assert.equal(first.file, '草稿/a.md');
    assert.equal(await fsp.readFile(path.join(dir, '草稿', 'a.md'), 'utf8'), 'keep\n');
    await assert.rejects(() => fsp.access(path.join(dir, 'notes', 'a.md')));
    const home = await moveSessionFile(dir, '草稿/a.md', '');
    assert.equal(home.file, 'a.md');
    await fsp.writeFile(path.join(dir, 'keep', 'a.md'), 'taken\n');
    await assert.rejects(() => moveSessionFile(dir, 'a.md', 'keep'), /已经有这个名字/);
    await assert.rejects(() => moveSessionFile(dir, 'keep', 'out'), /文件夹/);
    await assert.rejects(() => moveSessionFile(dir, '../escape.txt', 'out'), /只能挪/);
    await assert.rejects(() => moveSessionFile(dir, 'a.md', '.git'), /git/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 move', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/move/);
  assert.match(routes, /moveSessionFile/);
});
