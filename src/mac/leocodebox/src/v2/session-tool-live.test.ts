import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { clipLiveToolOutput, shouldOpenLiveTool } from './session-tool-live';

test('跑着的命令能看见输出', () => {
  assert.equal(clipLiveToolOutput('ok\n'), 'ok\n');
  assert.equal(clipLiveToolOutput(`head\n${'x'.repeat(2500)}`).length, 2000);
  assert.equal(shouldOpenLiveTool(true, 'PASS'), true);
  assert.equal(shouldOpenLiveTool(true, ''), false);
  assert.equal(shouldOpenLiveTool(false, 'PASS'), false);
  let view = applyEvent(emptyView(), {
    event: 'tool.started', tool: 'bash', tool_use_id: 't1', preview: 'npm test',
  });
  view = applyEvent(view, { event: 'tool.delta', tool_use_id: 't1', output: 'PASS 3\n' });
  const row = view.rows.find((item) => item.k === 'tool');
  assert.equal(row && row.k === 'tool' ? row.output : '', 'PASS 3\n');
  assert.equal(row && row.k === 'tool' ? row.running : false, true);
  view = applyEvent(view, { event: 'tool.completed', tool_use_id: 't1', output: 'PASS 3\n', error: false });
  const done = view.rows.find((item) => item.k === 'tool');
  assert.equal(done && done.k === 'tool' ? done.running : true, false);
});

test('2.0 跑着的输出不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /tool\.delta/);
  assert.match(flow, /row\.k === 'tool' && row\.running/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /跑着的命令|tool\.delta|clipLiveToolOutput/);
});
