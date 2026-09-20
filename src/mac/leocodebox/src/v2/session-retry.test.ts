import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView, lastLine } from './model';
import { sessionRetryLabel } from './session-retry';

test('过载会自己再试', () => {
  assert.equal(sessionRetryLabel({ attempt: 1, max: 3, delayMs: 2000 }), '过载，2 秒后再试 1/3。');
  assert.equal(sessionRetryLabel({ attempt: 2, max: 3 }), '过载，正在再试 2/3。');
  assert.equal(sessionRetryLabel({}), '过载，正在再试。');
  let view = applyEvent(emptyView(), { event: 'user.message', text: '改测试' });
  assert.equal(view.status, 'running');
  view = applyEvent(view, { event: 'session.retrying', attempt: 1, max: 3, delayMs: 2000 });
  assert.equal(view.status, 'running');
  const sys = view.rows.filter((row) => row.k === 'sys');
  assert.equal(sys.at(-1)?.text, '过载，2 秒后再试 1/3。');
  assert.equal(lastLine({
    status: 'running',
    last_event: { event: 'session.retrying', text: '过载，2 秒后再试 1/3。', timestamp: 1 },
    pending_approvals: [],
  }), '过载，2 秒后再试 1/3。');
});

test('2.0 过载再试不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /session\.retrying/);
  assert.match(model, /sessionRetryLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /再试|sessionRetryLabel|session\.retrying/);
});
