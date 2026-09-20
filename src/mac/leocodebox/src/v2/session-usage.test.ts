import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView, lastLine } from './model';
import { sessionUsageLabel } from './session-usage';

test('上一句能看见花了多少', () => {
  assert.equal(sessionUsageLabel({ totalTokens: 12_400 }), '这一轮 12K。');
  assert.equal(sessionUsageLabel({ input: 8000, output: 400 }), '这一轮 8K → 400。');
  assert.equal(sessionUsageLabel({}), '');
  let view = applyEvent(emptyView(), { event: 'message.delta', delta: '改完了' });
  view = applyEvent(view, { event: 'session.usage', totalTokens: 12_400 });
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '这一轮 12K。');
  assert.equal(lastLine({
    status: 'idle',
    last_event: { event: 'session.usage', text: '这一轮 12K。', timestamp: 1 },
    pending_approvals: [],
  }), '这一轮 12K。');
});

test('2.0 用量不进输入栏、不做统计按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /session\.usage/);
  assert.match(model, /sessionUsageLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /花了多少|sessionUsageLabel|get_session_stats/);
});
