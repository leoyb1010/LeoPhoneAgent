import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isThermalHot, thermalCoolToast, thermalHotToast, thermalSendToast } from './session-thermal';

test('能说出机器烫不烫', () => {
  assert.equal(isThermalHot('critical'), true);
  assert.equal(isThermalHot('serious'), true);
  assert.equal(isThermalHot('nominal'), false);
  assert.match(thermalHotToast('critical'), /很烫/);
  assert.match(thermalHotToast('serious'), /有点烫/);
  assert.match(thermalCoolToast(), /不烫/);
  assert.match(thermalSendToast(), /发烫/);
});

test('2.0 壳接上了发烫提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /thermalHotToast/);
  assert.match(app, /onThermalChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /发烫|很烫|thermalHotToast/);
});
