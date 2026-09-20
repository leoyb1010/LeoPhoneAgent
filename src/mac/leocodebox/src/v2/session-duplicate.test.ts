import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canDuplicateSessionFile, duplicateCopyName, duplicateSessionToast } from './session-duplicate';

test('只有本机看着的文件才能复制一份', () => {
  assert.equal(canDuplicateSessionFile('local', 'notes/a.md'), true);
  assert.equal(canDuplicateSessionFile('local', '  '), false);
  assert.equal(canDuplicateSessionFile('fold', 'notes/a.md'), false);
  assert.equal(duplicateCopyName('notes/a.md'), 'notes/a-副本.md');
  assert.equal(duplicateCopyName('a-副本.md'), 'a-副本.md');
  assert.match(duplicateSessionToast('notes/a-副本.md'), /a-副本/);
});

test('2.0 壳接上了复制一份，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /duplicateLocalFile/);
  assert.match(app, /复制一份/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /复制一份/);
});
