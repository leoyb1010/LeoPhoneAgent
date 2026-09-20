import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { approveAllLabel, approveAllToast, canApproveAllHere, pendingApprovalIds } from './session-approve-all';

test('能一次准掉这轮多条待批', () => {
  assert.deepEqual(pendingApprovalIds([{ approvalId: 'a' }, { approvalId: 'a' }, { approvalId: 'b' }]), ['a', 'b']);
  assert.equal(canApproveAllHere('local', ['a']), false);
  assert.equal(canApproveAllHere('local', ['a', 'b']), true);
  assert.equal(canApproveAllHere('phone', ['a', 'b']), false);
  assert.match(approveAllLabel(), /都准/);
  assert.match(approveAllToast(3), /3/);
});

test('2.0 壳接上了一次都准，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /approveAllPending|这次都准/);
  assert.match(app, /canApproveAllHere/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /都准|approveAll/);
});
