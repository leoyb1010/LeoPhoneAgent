import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canUnpackSessionZip, looksLikeZip, unpackSessionToast, unpackZipName } from './session-unpack';

test('只有本机才能解开会话目录里的 zip', () => {
  assert.equal(canUnpackSessionZip('local'), true);
  assert.equal(canUnpackSessionZip('fold'), false);
  assert.equal(looksLikeZip('leo-改动.zip'), true);
  assert.equal(looksLikeZip('notes.md'), false);
  assert.equal(unpackZipName('notes/leo-改动-登录.zip'), 'leo-改动-登录.zip');
  assert.equal(unpackZipName('readme.md'), '');
  assert.match(unpackSessionToast('leo-改动.zip', 3), /3/);
});

test('2.0 壳接上了解开 zip，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /unpackLocalZip/);
  assert.match(app, /解开这份 zip/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /解开这份 zip/);
});
