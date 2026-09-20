import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clipExportMarkdown, sanitizeExportName, writeSessionExport } from './session-export.js';

test('导出文件名只落在会话目录里', () => {
  assert.equal(sanitizeExportName('修 登录'), '修-登录.md');
  assert.equal(sanitizeExportName('../etc/passwd'), 'passwd.md');
  assert.ok(clipExportMarkdown('x'.repeat(10)).startsWith('x'));
  assert.throws(() => clipExportMarkdown('   '), /可记下的对话/);
});

test('本机目录能把对话写成 markdown，再写覆盖同一份', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-export-'));
  try {
    const first = await writeSessionExport(dir, { name: 'leo-对话.md', markdown: '# 一次\n\n你好' });
    assert.equal(first.name, 'leo-对话.md');
    assert.equal(await fs.readFile(first.path, 'utf8'), '# 一次\n\n你好\n');
    const again = await writeSessionExport(dir, { name: 'leo-对话.md', markdown: '# 二次\n\n改过了' });
    assert.equal(again.path, first.path);
    assert.equal(await fs.readFile(again.path, 'utf8'), '# 二次\n\n改过了\n');
    const escaped = await writeSessionExport(dir, { name: '../x.md', markdown: 'ok' });
    assert.equal(escaped.name, 'x.md');
    assert.equal(path.dirname(escaped.path), path.resolve(dir));
    await assert.rejects(() => writeSessionExport('/', { name: 'leo-对话.md', markdown: 'no' }), /不能记下对话/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
