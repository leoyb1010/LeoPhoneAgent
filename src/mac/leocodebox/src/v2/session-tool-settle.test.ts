import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { sessionToolSettleRows } from './session-tool-settle';

test('没跑完的会收住', () => {
  const open = [{ k: 'tool' as const, running: true, error: false }];
  const settled = sessionToolSettleRows(open, true);
  assert.equal(settled[0]?.running, false);
  assert.equal(settled[0]?.error, true);
  assert.equal(sessionToolSettleRows([{ k: 'sys' as const, running: false }], true)[0]?.k, 'sys');

  let view = applyEvent(emptyView(), { event: 'tool.started', tool: 'bash', preview: 'npm test', tool_use_id: 't1' });
  assert.equal(view.rows.some((row) => row.k === 'tool' && row.running), true);
  view = applyEvent(view, { event: 'session.aborted' });
  const tool = view.rows.find((row) => row.k === 'tool');
  assert.equal(tool && tool.k === 'tool' && tool.running, false);
  assert.equal(tool && tool.k === 'tool' && tool.error, true);
});

test('2.0 收住不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /sessionToolSettleRows/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /收住|sessionToolSettleRows/);
});
