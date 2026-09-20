import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SEARCH_MAX_HITS, clipSearchLine, searchSessionCwd } from './session-search.js';

test('搜正文跳过 node_modules，拦系统目录和太短的字', async () => {
  assert.equal(clipSearchLine('  a   b  '), 'a b');
  await assert.rejects(() => searchSessionCwd('/', 'hello'), /不能搜/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-search-'));
  try {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const pin = true;\nconst other = 1;\n');
    await fs.writeFile(path.join(dir, 'readme.md'), '重要的会话可以钉住\n');
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'export const pin = "secret";\n');
    await fs.writeFile(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await assert.rejects(() => searchSessionCwd(dir, '钉'), /至少两个字/);
    const found = await searchSessionCwd(dir, 'pin');
    assert.equal(found.query, 'pin');
    assert.deepEqual(found.hits.map((hit) => `${hit.file}:${hit.line}`), ['src/a.ts:1']);
    assert.equal(found.truncated, false);

    const chinese = await searchSessionCwd(dir, '钉住');
    assert.equal(chinese.hits.length, 1);
    assert.equal(chinese.hits[0]?.file, 'readme.md');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('命中封顶就诚实说还有', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-search-cap-'));
  try {
    const lines = Array.from({ length: SEARCH_MAX_HITS + 5 }, (_, i) => `hit line ${i} needle`);
    await fs.writeFile(path.join(dir, 'many.txt'), `${lines.join('\n')}\n`);
    const found = await searchSessionCwd(dir, 'needle');
    assert.equal(found.hits.length, SEARCH_MAX_HITS);
    assert.equal(found.truncated, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
