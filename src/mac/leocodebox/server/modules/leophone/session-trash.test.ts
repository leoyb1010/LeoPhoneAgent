import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { trashSessionFile } from './session-trash.js';

test('会话目录里的文件能扔掉，穿越和文件夹会拦', async () => {
  await assert.rejects(() => trashSessionFile('/', 'a.txt'), /不能扔文件/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-trash-'));
  try {
    await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes', 'a.md'), 'bye\n');
    await fsp.mkdir(path.join(dir, 'keep'));
    const gone = await trashSessionFile(dir, 'notes/a.md');
    assert.equal(gone.file, 'notes/a.md');
    await assert.rejects(() => fsp.access(path.join(dir, 'notes', 'a.md')));
    await assert.rejects(() => trashSessionFile(dir, 'notes/a.md'), /没有这份文件/);
    await assert.rejects(() => trashSessionFile(dir, 'keep'), /文件夹/);
    await assert.rejects(() => trashSessionFile(dir, '../escape.txt'), /只能扔/);
    await assert.rejects(() => trashSessionFile(dir, '.git/config'), /git/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 trash', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/trash/);
  assert.match(routes, /trashSessionFile/);
});
