import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRewindLastTurn, dropLastPromptTurn, rewindLastTurnLabel, rewindLastTurnToast } from './session-rewind';
import type { FlowRow } from './model';

const user = (text: string, mode: 'prompt' | 'steer' = 'prompt'): FlowRow => (
  { k: 'user', key: text, text, mode }
);
const ai = (text: string): FlowRow => ({ k: 'ai', key: text, text, streaming: false });

test('能把上一轮拿掉再改', () => {
  const rows = [user('先改这里'), ai('改完了'), user('再改一处'), ai('又改了')];
  assert.equal(canRewindLastTurn({ machine: 'local', status: 'idle', rows }), true);
  assert.equal(canRewindLastTurn({ machine: 'local', status: 'running', rows }), false);
  assert.equal(canRewindLastTurn({ machine: 'phone', status: 'idle', rows }), false);
  assert.equal(canRewindLastTurn({ machine: 'local', status: 'idle', rows: [] }), false);
  assert.deepEqual(dropLastPromptTurn(rows, '再改一处').map((row) => row.k === 'user' ? row.text : row.k), ['先改这里', 'ai']);
  assert.deepEqual(dropLastPromptTurn(rows, '没有这句').map((row) => row.k), ['user', 'ai', 'user', 'ai']);
  assert.match(rewindLastTurnLabel(), /不算/);
  assert.match(rewindLastTurnToast(), /拿掉/);
});

test('2.0 拿掉上一轮不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const harness = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(app, /rewindLastTurnLabel|这一轮不算/);
  assert.match(app, /api\.rewindLocal/);
  assert.match(harness, /rewindLastTurn/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这一轮不算|rewindLast/);
});
