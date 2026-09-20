import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { abortTurnLabel, abortTurnToast, canAbortTurn } from './session-abort';

test('能只停这一轮，会话还在', () => {
  assert.equal(canAbortTurn('local', 'running'), true);
  assert.equal(canAbortTurn('local', 'waiting_for_approval'), true);
  assert.equal(canAbortTurn('local', 'idle'), false);
  assert.equal(canAbortTurn('phone', 'running'), false);
  assert.match(abortTurnLabel(), /停这一轮/);
  assert.match(abortTurnToast(), /还在/);
  const view = applyEvent(emptyView(), { event: 'session.aborted' });
  assert.equal(view.status, 'idle');
  const last = view.rows[view.rows.length - 1];
  assert.equal(last?.k, 'sys');
  if (last?.k === 'sys') assert.match(last.text, /停这一轮/);
});

test('2.0 壳接上了停这一轮，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /abortTurn|停这一轮/);
  assert.match(app, /type: 'abort'/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /停这一轮|abortTurn/);
});
