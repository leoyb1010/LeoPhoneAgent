import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canStopSession, stopSessionToast, stoppableLocalSessions } from './session-stop';

test('只有本机正在跑的能单独停掉', () => {
  assert.equal(canStopSession('local', 'running'), true);
  assert.equal(canStopSession('local', 'starting'), true);
  assert.equal(canStopSession('local', 'waiting_for_approval'), true);
  assert.equal(canStopSession('local', 'idle'), false);
  assert.equal(canStopSession('fold', 'running'), false);
  assert.deepEqual(
    stoppableLocalSessions([
      { machine: 'local', s: { status: 'running', session_id: 'a', title: '写文件' } },
      { machine: 'local', s: { status: 'idle', session_id: 'b' } },
      { machine: 'fold', s: { status: 'running', session_id: 'c' } },
    ]).map((row) => row.s?.session_id),
    ['a'],
  );
  assert.equal(stopSessionToast('写文件'), '已停掉 写文件');
  assert.equal(stopSessionToast(''), '已停掉这条会话');
});

test('2.0 壳接上了停掉这条，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /stopTarget/);
  assert.match(app, /停掉这条/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /停掉这条/);
});
