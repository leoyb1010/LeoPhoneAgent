import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyDroppedFile, resolveDropDest, writeDroppedBytes } from './local-drop.ts';

test('放入会话目录:项目内能写,越界和系统目录不能写', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-drop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const dest = resolveDropDest(root, '../secret.txt');
  assert.equal(path.dirname(dest), root);
  assert.equal(path.basename(dest), 'secret.txt');

  assert.throws(() => resolveDropDest('/etc', 'hosts'), /不能放文件/);

  const written = await writeDroppedBytes(root, 'shot.png', Buffer.from('png'));
  assert.equal(await fs.readFile(written.path, 'utf8'), 'png');
  assert.equal(path.dirname(written.path), root);

  const again = await writeDroppedBytes(root, 'shot.png', Buffer.from('png2'));
  assert.equal(path.basename(again.path), 'shot-2.png');
});

test('拷贝已有文件进会话目录,系统路径拒绝', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-drop-src-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'note.txt');
  await fs.writeFile(src, 'hello');
  const copied = await copyDroppedFile(root, src);
  assert.equal(await fs.readFile(copied.path, 'utf8'), 'hello');
  assert.notEqual(copied.path, src);
  await assert.rejects(() => copyDroppedFile(root, '/etc/hosts'), /不能放入|不能放/);
});
