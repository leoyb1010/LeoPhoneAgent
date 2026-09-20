import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView, lastLine } from './model';
import { sessionCompactedLabel, sessionCompactingLabel } from './session-compact-live';

test('上下文满了会自己压', () => {
  assert.equal(sessionCompactingLabel(), '正在压缩上下文。');
  assert.equal(sessionCompactedLabel({ tokensBefore: 150_000, tokensAfter: 32_000 }), '已压缩：150K → 32K。');
  assert.equal(sessionCompactedLabel({ aborted: true }), '压缩被停掉了。');
  assert.match(sessionCompactedLabel({}), /摘要/);
  let view = applyEvent(emptyView(), { event: 'user.message', text: '继续改' });
  view = applyEvent(view, { event: 'session.compacting', reason: 'threshold' });
  assert.equal(view.status, 'running');
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '正在压缩上下文。');
  view = applyEvent(view, { event: 'session.compacted', tokensBefore: 150_000, tokensAfter: 32_000 });
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '已压缩：150K → 32K。');
  assert.equal(lastLine({
    status: 'running',
    last_event: { event: 'session.compacting', text: '正在压缩上下文。', timestamp: 1 },
    pending_approvals: [],
  }), '正在压缩上下文。');
});

test('2.0 自己压不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /session\.compacting/);
  assert.match(model, /sessionCompactingLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /自己压|sessionCompactingLabel|session\.compacting/);
});
