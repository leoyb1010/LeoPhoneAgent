import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSearchSession, clipSearchLine, searchQueryReady, searchSessionToast } from './session-search';

test('只有本机、至少两个字才搜', () => {
  assert.equal(canSearchSession('local'), true);
  assert.equal(canSearchSession('fold'), false);
  assert.equal(searchQueryReady('钉'), false);
  assert.equal(searchQueryReady('钉住'), true);
  assert.equal(clipSearchLine('  a   b  '), 'a b');
  assert.match(clipSearchLine('x'.repeat(200)), /…$/);
  assert.match(searchSessionToast(0, false), /没有/);
  assert.match(searchSessionToast(3, false), /3/);
  assert.match(searchSessionToast(40, true), /还有/);
});

test('2.0 壳接上了在目录里搜', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /searchLocalCwd/);
  assert.match(app, /在目录里搜/);
});
