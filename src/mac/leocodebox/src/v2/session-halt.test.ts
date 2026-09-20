import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { busyLocalSessionIds, canHaltBusySessions, haltSessionsToast, sessionIsBusyToHalt } from './session-halt';

test('只有本机正在跑或等审批的会话能一次停掉', () => {
  assert.equal(sessionIsBusyToHalt('running'), true);
  assert.equal(sessionIsBusyToHalt('starting'), true);
  assert.equal(sessionIsBusyToHalt('waiting_for_approval'), true);
  assert.equal(sessionIsBusyToHalt('idle'), false);
  assert.equal(sessionIsBusyToHalt('completed'), false);
  assert.equal(canHaltBusySessions([
    { machine: 'local', s: { status: 'idle' } },
    { machine: 'fold', s: { status: 'running' } },
  ]), false);
  assert.deepEqual(busyLocalSessionIds([
    { machine: 'local', s: { status: 'running', session_id: 'a' } },
    { machine: 'local', s: { status: 'idle', session_id: 'b' } },
    { machine: 'local', s: { status: 'starting', session_id: 'c' } },
  ]), ['a', 'c']);
  assert.match(haltSessionsToast(2), /2/);
});

test('2.0 壳接上了停掉正在跑的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /haltBusyLocal/);
  assert.match(app, /停掉正在跑的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /停掉正在跑的/);
});
