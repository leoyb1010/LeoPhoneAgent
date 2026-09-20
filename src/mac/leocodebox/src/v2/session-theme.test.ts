import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { followSystemLabel, followSystemToast } from './session-theme';

test('跟系统外观的文案', () => {
  assert.equal(followSystemLabel('dark'), '跟随系统');
  assert.equal(followSystemLabel('light'), '跟随系统');
  assert.equal(followSystemLabel('system'), '现在跟着系统');
  assert.match(followSystemToast('dark'), /已跟随系统外观/);
  assert.match(followSystemToast('system'), /已经在跟随系统/);
});

test('2.0 壳接上了跟随系统，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /followSystemLabel|跟随系统/);
  assert.match(app, /setThemeMode\('system'\)/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /跟随系统|已跟随系统外观/);
});
