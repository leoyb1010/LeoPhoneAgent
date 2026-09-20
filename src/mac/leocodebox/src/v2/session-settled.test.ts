import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { isRunTerminal } from './session-settled';

test('排着的下一句会跑完', () => {
  assert.equal(isRunTerminal('run.completed'), true);
  assert.equal(isRunTerminal('agent_end'), false);
  assert.equal(isRunTerminal('session.retrying'), false);
  let view = applyEvent(emptyView(), { event: 'user.message', text: '先改测试' });
  view = applyEvent(view, { event: 'user.message', text: '再提交', mode: 'follow_up' });
  view = applyEvent(view, { event: 'message.delta', delta: '改完了' });
  assert.equal(view.status, 'running');
  view = applyEvent(view, { event: 'run.completed' });
  assert.equal(view.status, 'idle');
});

test('2.0 接着跑完不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /agent_settled/);
  assert.match(dialect, /skipSettledComplete/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /跑完|agent_settled|isRunTerminal/);
});
