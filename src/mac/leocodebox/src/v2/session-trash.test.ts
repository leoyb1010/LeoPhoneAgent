import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canTrashSessionFile, trashSessionToast } from './session-trash';

test('只有本机看着的文件才能扔掉', () => {
  assert.equal(canTrashSessionFile('local', 'notes/a.md'), true);
  assert.equal(canTrashSessionFile('local', '  '), false);
  assert.equal(canTrashSessionFile('fold', 'notes/a.md'), false);
  assert.match(trashSessionToast('notes/a.md'), /a\.md/);
});

test('2.0 壳接上了扔掉文件，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /trashLocalFile/);
  assert.match(app, /扔掉这份文件/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /扔掉这份文件/);
});
