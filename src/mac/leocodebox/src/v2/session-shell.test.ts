import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { canRunSessionBash, parseComposerBash } from './session-shell';

test('输入栏 $ 能把命令跑进会话', () => {
  assert.equal(parseComposerBash('$ npm test'), 'npm test');
  assert.equal(parseComposerBash('$\nls -la'), 'ls -la');
  assert.equal(parseComposerBash('$'), null);
  assert.equal(parseComposerBash('$npm test'), null);
  assert.equal(parseComposerBash('跑 $ npm test'), null);
  const ready = { machine: 'local', status: 'idle', command: 'npm test' };
  assert.equal(canRunSessionBash(ready), true);
  assert.equal(canRunSessionBash({ ...ready, status: 'failed' }), true);
  assert.equal(canRunSessionBash({ ...ready, status: 'running' }), false);
  assert.equal(canRunSessionBash({ ...ready, status: 'waiting_for_approval' }), false);
  assert.equal(canRunSessionBash({ ...ready, machine: 'phone' }), false);
  assert.equal(canRunSessionBash({ ...ready, command: '' }), false);
  let view = applyEvent(emptyView(), {
    event: 'tool.started', tool: 'bash', tool_use_id: 'sh1', preview: 'npm test',
  });
  view = applyEvent(view, { event: 'tool.delta', tool_use_id: 'sh1', output: 'PASS\n' });
  const row = view.rows.find((item) => item.k === 'tool');
  assert.equal(row && row.k === 'tool' ? row.preview : '', 'npm test');
  assert.equal(row && row.k === 'tool' ? row.output : '', 'PASS\n');
});

test('2.0 会话里跑命令不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(app, /parseComposerBash/);
  assert.match(app, /canRunSessionBash/);
  assert.match(app, /type: 'bash'/);
  assert.match(routes, /'bash'/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /跑进会话|parseComposerBash|canRunSessionBash/);
});
