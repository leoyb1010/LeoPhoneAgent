import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMkdirSessionFolder, mkdirSessionToast, sanitizeFolderRel } from './session-mkdir';

test('只有本机才能当场建文件夹', () => {
  assert.equal(canMkdirSessionFolder('local'), true);
  assert.equal(canMkdirSessionFolder('fold'), false);
  assert.equal(sanitizeFolderRel('notes/草稿'), 'notes/草稿');
  assert.equal(sanitizeFolderRel('../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeFolderRel(''), 'leo-新建');
  assert.match(mkdirSessionToast('notes/草稿'), /草稿/);
});

test('2.0 壳接上了建文件夹，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mkdirLocalFolder/);
  assert.match(app, /建这个文件夹/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /建这个文件夹/);
});
