import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { lastAbruptToast, lastRunWasAbrupt } from './session-crash';

test('能认出上次崩了', () => {
  assert.equal(lastRunWasAbrupt({ abrupt: true }), true);
  assert.equal(lastRunWasAbrupt({ abrupt: false }), false);
  assert.equal(lastRunWasAbrupt(null), false);
  assert.match(lastAbruptToast(), /异常退出/);
});

test('2.0 壳接上了崩了提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /lastAbruptToast/);
  assert.match(app, /readLastAbrupt/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /异常退出|lastAbruptToast/);
});
