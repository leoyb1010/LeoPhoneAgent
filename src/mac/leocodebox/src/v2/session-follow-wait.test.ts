import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canQueueWhileWaiting } from './session-follow-wait';

test('要批准时发送会排到后面', () => {
  assert.equal(canQueueWhileWaiting({ machine: 'local', status: 'waiting_for_approval', prompt: '再跑测试' }), true);
  assert.equal(canQueueWhileWaiting({ machine: 'local', status: 'running', prompt: '再跑测试' }), false);
  assert.equal(canQueueWhileWaiting({ machine: 'local', status: 'waiting_for_approval', prompt: '  ' }), false);
  assert.equal(canQueueWhileWaiting({ machine: 'phone', status: 'waiting_for_approval', prompt: '再跑测试' }), false);
});

test('2.0 待批发送排队不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canQueueWhileWaiting/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /排到后面|canQueueWhileWaiting/);
});
