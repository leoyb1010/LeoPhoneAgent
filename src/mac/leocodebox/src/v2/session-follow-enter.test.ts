import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canQueueOnEnter, queueOnEnterToast } from './session-follow-enter';

test('跑着回车会排到下一句', () => {
  assert.equal(canQueueOnEnter({ machine: 'local', status: 'running', prompt: '再改测试' }), true);
  assert.equal(canQueueOnEnter({ machine: 'local', status: 'starting', prompt: '再改测试' }), true);
  assert.equal(canQueueOnEnter({ machine: 'local', status: 'idle', prompt: '再改测试' }), false);
  assert.equal(canQueueOnEnter({ machine: 'local', status: 'waiting_for_approval', prompt: '再改测试' }), false);
  assert.equal(canQueueOnEnter({ machine: 'phone', status: 'running', prompt: '再改测试' }), false);
  assert.equal(canQueueOnEnter({ machine: 'local', status: 'running', prompt: '  ' }), false);
  assert.match(queueOnEnterToast(), /排在后面/);
});

test('2.0 跑着回车排队不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canQueueOnEnter/);
  assert.match(app, /void followUp\(\)/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /排到下一句|queueOnEnter/);
});
