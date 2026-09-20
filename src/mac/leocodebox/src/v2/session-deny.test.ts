import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { canDenyWithReason, clipDenyReason, denySessionToast } from './session-deny';

test('拒绝带上为什么会写进流水', () => {
  const asked = applyEvent(emptyView(), { event: 'approval.request', approval_id: 'a1', command: 'rm build', choices: ['once', 'deny'] });
  const denied = applyEvent(asked, { event: 'approval.responded', approval_id: 'a1', choice: 'deny', reason: '不要删，改挪走' });
  assert.equal(denied.pendingApprovals.size, 0);
  assert.equal(denied.rows[0]?.k, 'sys');
  if (denied.rows[0]?.k === 'sys') assert.match(denied.rows[0].text, /不要删，改挪走/);
});

test('拒绝可以带上一句为什么', () => {
  assert.equal(canDenyWithReason(['once', 'deny']), true);
  assert.equal(canDenyWithReason(['once']), false);
  assert.equal(clipDenyReason('  不要删，改挪走  \n'), '不要删，改挪走');
  assert.equal(clipDenyReason('x'.repeat(240)).length, 200);
  assert.equal(denySessionToast('不要删'), '已拒绝，并告诉了模型为什么');
  assert.equal(denySessionToast('  '), '已拒绝');
});

test('2.0 壳接上了拒绝为什么，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /denySessionToast/);
  assert.match(flow, /拒绝的话，可以写为什么/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /拒绝的话/);
});
