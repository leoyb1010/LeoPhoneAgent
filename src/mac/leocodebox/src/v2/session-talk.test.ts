import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSearchSessionTalk, talkQueryReady, talkSearchToast } from './session-talk';

test('只有本机才能按说过的话找会话', () => {
  assert.equal(canSearchSessionTalk('local'), true);
  assert.equal(canSearchSessionTalk('fold'), false);
  assert.equal(talkQueryReady('改'), false);
  assert.equal(talkQueryReady('登录'), true);
  assert.match(talkSearchToast(2), /2/);
});

test('2.0 壳左栏找会话会搜正文，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /searchLocalTalk/);
  assert.match(app, /talkIds/);
  assert.match(app, /找会话或说过的话/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /找会话或说过的话/);
});
