import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canQueueAfterApprove, queueAfterApproveToast } from './session-approve-queue';

test('准完会把输入栏排上', () => {
  assert.equal(canQueueAfterApprove({
    machine: 'local', sameSession: true, status: 'waiting_for_approval', choice: 'once', prompt: '再跑测试',
  }), true);
  assert.equal(canQueueAfterApprove({
    machine: 'local', sameSession: true, status: 'waiting_for_approval', choice: 'deny', prompt: '再跑测试',
  }), false);
  assert.equal(canQueueAfterApprove({
    machine: 'local', sameSession: false, status: 'waiting_for_approval', choice: 'once', prompt: '再跑测试',
  }), false);
  assert.equal(canQueueAfterApprove({
    machine: 'phone', sameSession: true, status: 'waiting_for_approval', choice: 'once', prompt: '再跑测试',
  }), false);
  assert.equal(canQueueAfterApprove({
    machine: 'local', sameSession: true, status: 'running', choice: 'once', prompt: '再跑测试',
  }), false);
  assert.equal(canQueueAfterApprove({
    machine: 'local', sameSession: true, status: 'waiting_for_approval', choice: 'once', prompt: '  ',
  }), false);
  assert.equal(queueAfterApproveToast(), '已准，并把这句话排上');
});

test('2.0 准完排队不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canQueueAfterApprove/);
  assert.match(app, /follow_up/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /准完|canQueueAfterApprove|排上/);
});
