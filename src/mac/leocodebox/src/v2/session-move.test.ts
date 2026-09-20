import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMoveSessionFile, moveDestRel, moveSessionToast, sanitizeMoveFolder } from './session-move';

test('只有本机看着的文件才能挪进文件夹', () => {
  assert.equal(canMoveSessionFile('local', 'notes/a.md'), true);
  assert.equal(canMoveSessionFile('local', '  '), false);
  assert.equal(canMoveSessionFile('fold', 'notes/a.md'), false);
  assert.equal(sanitizeMoveFolder('../etc/passwd'), 'etc/passwd');
  assert.equal(moveDestRel('notes/a.md', '草稿'), '草稿/a.md');
  assert.equal(moveDestRel('notes/a.md', ''), 'a.md');
  assert.match(moveSessionToast('草稿/a.md'), /草稿\/a.md/);
});

test('2.0 壳接上了挪进文件夹，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /moveLocalFile/);
  assert.match(app, /挪进这个文件夹/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /挪进这个文件夹/);
});
