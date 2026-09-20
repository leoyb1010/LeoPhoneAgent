import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { sanitizeSeedRel, seedSessionFile } from './session-seed.js';

test('新建文件名会收成会话目录里的相对路径', () => {
  assert.equal(sanitizeSeedRel('notes/hello.md'), 'notes/hello.md');
  assert.equal(sanitizeSeedRel('../secret'), 'secret');
});

test('本机目录能建文件，已有的和穿越的都会被拦', async () => {
  await assert.rejects(() => seedSessionFile('/', { name: 'a.txt', text: 'x' }), /不能建文件/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-seed-'));
  try {
    const first = await seedSessionFile(dir, { name: 'notes/hello.md', text: 'hi\n' });
    assert.equal(first.file, 'notes/hello.md');
    assert.equal(await fs.readFile(first.path, 'utf8'), 'hi\n');
    await assert.rejects(() => seedSessionFile(dir, { name: 'notes/hello.md', text: 'again' }), /已经有这个文件/);
    const escaped = await seedSessionFile(dir, { name: '../escape.txt', text: 'no' });
    assert.equal(escaped.file, 'escape.txt');
    assert.equal(await fs.realpath(path.dirname(escaped.path)), await fs.realpath(dir));
    await assert.rejects(() => fs.access(path.resolve(dir, '..', 'escape.txt')));
    const blank = await seedSessionFile(dir, { name: 'empty.txt', text: '' });
    assert.equal(await fs.readFile(blank.path, 'utf8'), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
