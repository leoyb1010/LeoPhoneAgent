import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { lastCwdHabit, pickCwdModel, pickCwdPolicy, rememberCwdHabit } from './session-cwd-habit';

test('这个目录会记住上次怎么开，换目录不串', () => {
  let store = rememberCwdHabit({}, '/tmp/app/', { model: 'xai/grok-4.6', policy: 'accept_edits' });
  store = rememberCwdHabit(store, '/tmp/other', { model: 'anthropic/claude-opus-5', policy: 'plan' });
  const raw = JSON.stringify(store);
  assert.deepEqual(lastCwdHabit('/tmp/app', raw), { model: 'xai/grok-4.6', policy: 'accept_edits' });
  assert.equal(pickCwdModel({ cwd: '/tmp/app/', habits: raw, fallback: 'openai/old' }), 'xai/grok-4.6');
  assert.equal(pickCwdPolicy({ cwd: '/tmp/app', habits: raw, fallback: 'default' }), 'accept_edits');
  assert.equal(pickCwdModel({ cwd: '/tmp/other', habits: raw }), 'anthropic/claude-opus-5');
  assert.equal(pickCwdModel({ cwd: '/tmp/app', habits: raw, explicit: 'openai/gpt-5.5' }), 'openai/gpt-5.5');
  assert.equal(pickCwdModel({ cwd: '/tmp/unknown', habits: raw, fallback: 'openai/old' }), 'openai/old');
  assert.equal(pickCwdPolicy({ cwd: '/tmp/unknown', habits: raw, fallback: 'default' }), 'default');
});

test('2.0 壳接上了目录习惯，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /saveCwdHabit/);
  assert.match(flow, /pickCwdModel/);
  assert.match(flow, /saveCwdHabit/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这个目录会记住/);
});
