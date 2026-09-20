import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { batterySendToast, onAcToast, onBatteryToast } from './session-battery';

test('能说出用电池还是插电', () => {
  assert.match(onBatteryToast(), /电池/);
  assert.match(onAcToast(), /电源/);
  assert.match(batterySendToast(), /吃电/);
});

test('2.0 壳接上了电池提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /onBatteryToast/);
  assert.match(app, /onBatteryChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /电池|吃电|onBatteryToast/);
});
