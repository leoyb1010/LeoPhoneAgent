import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canForgetEndedSessions, endedLocalSessionIds, forgetEndedToast } from './session-forget';

test('只有本机已经结束、又没钉住的会话能一次清掉', () => {
  assert.equal(canForgetEndedSessions([
    { machine: 'local', s: { status: 'idle', session_id: 'live' } },
    { machine: 'fold', s: { status: 'completed', session_id: 'remote' } },
  ]), false);
  assert.deepEqual(endedLocalSessionIds([
    { machine: 'local', s: { status: 'completed', session_id: 'a' } },
    { machine: 'local', s: { status: 'idle', session_id: 'b' } },
    { machine: 'local', s: { status: 'failed', session_id: 'c' } },
    { machine: 'local', s: { status: 'orphaned', session_id: 'd' } },
    { machine: 'fold', s: { status: 'cancelled', session_id: 'e' } },
  ], ['local:d']), ['a', 'c']);
  assert.match(forgetEndedToast(2), /2/);
});

test('2.0 壳接上了清掉已经结束的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /forgetEndedLocal/);
  assert.match(app, /清掉已经结束的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /清掉已经结束的/);
});
