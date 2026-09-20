import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { comparePinnedFirst, pinSessionToast, readPinnedSessionKeys, sessionIsPinned, togglePinnedSessionKey } from './session-pin';

test('钉住可以开关，读坏数据当没有', () => {
  const next = togglePinnedSessionKey([], 'local:hs_1');
  assert.deepEqual(next, ['local:hs_1']);
  assert.equal(sessionIsPinned(next, 'local', 'hs_1'), true);
  assert.deepEqual(togglePinnedSessionKey(next, 'local:hs_1'), []);
  assert.deepEqual(readPinnedSessionKeys('not-json'), []);
  assert.deepEqual(readPinnedSessionKeys('["local:a","x"]'), ['local:a']);
  assert.equal(comparePinnedFirst(true, false, 9), -1);
  assert.equal(comparePinnedFirst(false, false, 3), 3);
  assert.match(pinSessionToast(true), /钉在左栏/);
});

test('2.0 壳接上了钉在左栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /togglePinnedSessionKey/);
  assert.match(app, /PINNED_SESSIONS_KEY/);
  assert.match(app, /钉在左栏/);
});
