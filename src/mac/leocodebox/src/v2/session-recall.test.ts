import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { removeHiddenSessionKey, sessionKey } from './model';
import { canRecallForgotten, recallSessionToast } from './session-recall';

test('只有本机才能找回拿掉的会话', () => {
  assert.equal(canRecallForgotten('local'), true);
  assert.equal(canRecallForgotten('fold'), false);
  assert.match(recallSessionToast('修登录'), /修登录/);
  assert.deepEqual(removeHiddenSessionKey(['local:a', 'local:b'], sessionKey('local', 'a')), ['local:b']);
});

test('2.0 壳接上了找回来，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /recallForgottenLocal/);
  assert.match(app, /找回来/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /找回来/);
});
