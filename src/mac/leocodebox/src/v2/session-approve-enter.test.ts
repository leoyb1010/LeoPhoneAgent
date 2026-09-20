import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canApproveOnEnter } from './session-approve-enter';

test('要批准时回车就准', () => {
  assert.equal(canApproveOnEnter({ machine: 'local', status: 'waiting_for_approval', pendingCount: 1 }), true);
  assert.equal(canApproveOnEnter({ machine: 'local', status: 'waiting_for_approval', pendingCount: 2 }), true);
  assert.equal(canApproveOnEnter({ machine: 'local', status: 'waiting_for_approval', pendingCount: 0 }), false);
  assert.equal(canApproveOnEnter({ machine: 'local', status: 'running', pendingCount: 1 }), false);
  assert.equal(canApproveOnEnter({ machine: 'phone', status: 'waiting_for_approval', pendingCount: 1 }), false);
});

test('2.0 待批回车不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canApproveOnEnter/);
  assert.match(app, /approveFirstPending/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /回车就准|canApproveOnEnter/);
});
