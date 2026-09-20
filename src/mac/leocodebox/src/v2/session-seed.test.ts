import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSeedSessionFile, clipSeedText, sanitizeSeedRel, seedSessionToast } from './session-seed';

test('只有本机才能当场建文件', () => {
  assert.equal(canSeedSessionFile('local'), true);
  assert.equal(canSeedSessionFile('fold'), false);
  assert.equal(sanitizeSeedRel('src/新 笔记.md'), 'src/新-笔记.md');
  assert.equal(sanitizeSeedRel('../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeSeedRel(''), 'leo-新建.txt');
  assert.equal(clipSeedText('hello'), 'hello');
  assert.match(seedSessionToast('src/a.md'), /src\/a.md/);
});

test('2.0 壳接上了建文件，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /seedLocalFile/);
  assert.match(app, /建这个文件/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,600}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /建这个文件/);
});
