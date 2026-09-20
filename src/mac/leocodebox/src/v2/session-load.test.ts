import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadBusyToast, loadOkToast, loadSendToast } from './session-load';

test('能说出机器忙不忙', () => {
  assert.match(loadBusyToast(), /忙/);
  assert.match(loadOkToast(), /不忙/);
  assert.match(loadSendToast(), /很忙/);
});

test('2.0 壳接上了忙闲提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /loadBusyToast/);
  assert.match(app, /onLoadChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /很忙|loadBusyToast/);
});
