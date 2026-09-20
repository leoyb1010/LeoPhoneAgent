import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canDenyAllHere, deniableApprovalIds, denyAllLabel, denyAllToast } from './session-deny-all';

test('能一次拒掉这轮多条待批', () => {
  assert.deepEqual(deniableApprovalIds([
    { approvalId: 'a', choices: ['once', 'deny'] },
    { approvalId: 'a', choices: ['once', 'deny'] },
    { approvalId: 'b', choices: ['once'] },
    { approvalId: 'c', choices: ['deny'] },
  ]), ['a', 'c']);
  assert.equal(canDenyAllHere('local', ['a']), false);
  assert.equal(canDenyAllHere('local', ['a', 'c']), true);
  assert.equal(canDenyAllHere('phone', ['a', 'c']), false);
  assert.match(denyAllLabel(), /都拒/);
  assert.match(denyAllToast(3), /3/);
});

test('2.0 壳接上了一次都拒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /denyAllPending|这次都拒/);
  assert.match(app, /canDenyAllHere/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /都拒|denyAll/);
});
