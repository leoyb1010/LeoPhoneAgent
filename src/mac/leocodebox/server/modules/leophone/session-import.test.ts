import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readSessionImport, sanitizeImportName } from './session-import.js';

test('只能接回 leo-对话 markdown', () => {
  assert.equal(sanitizeImportName('leo-对话-修登录.md'), 'leo-对话-修登录.md');
  assert.throws(() => sanitizeImportName('README.md'), /只能接回/);
  assert.throws(() => sanitizeImportName('../leo-对话.md'), /只能接回/);
});

test('本机目录能读最近一份记下的对话', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-import-'));
  try {
    await fs.writeFile(path.join(dir, 'README.md'), '# 不是对话', 'utf8');
    await fs.writeFile(path.join(dir, 'leo-对话-旧.md'), '# 旧\n\n先写的', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(dir, 'leo-对话-新.md'), '# 新\n\n后写的', 'utf8');
    const newest = await readSessionImport(dir);
    assert.equal(newest.name, 'leo-对话-新.md');
    assert.match(newest.markdown, /后写的/);
    const named = await readSessionImport(dir, 'leo-对话-旧.md');
    assert.equal(named.name, 'leo-对话-旧.md');
    assert.match(named.markdown, /先写的/);
    await assert.rejects(() => readSessionImport(dir, 'README.md'), /只能接回/);
    await assert.rejects(() => readSessionImport('/'), /不能接回对话|没有记下的对话/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
