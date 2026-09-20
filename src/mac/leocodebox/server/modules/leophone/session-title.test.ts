import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clipSessionTitle, readTitleSidecar, writeTitleSidecar } from './session-title.js';

test('标题裁成一行，空的不写', () => {
  assert.equal(clipSessionTitle('  修\n登录  '), '修 登录');
  assert.throws(() => writeTitleSidecar('/tmp/x.ndjson', '   '), /写一个标题/);
});

test('旁路文件重启还能读回自己起的名字', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-title-'));
  try {
    const log = path.join(dir, 'hs_demo.ndjson');
    const saved = writeTitleSidecar(log, '修登录');
    assert.equal(saved, '修登录');
    assert.equal(readTitleSidecar(log), '修登录');
    writeTitleSidecar(log, '改过了');
    assert.equal(readTitleSidecar(log), '改过了');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
