import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { thermalState } from './thermal.js';

test('能认出机器是不是发烫', () => {
  assert.deepEqual(thermalState({ getCurrentThermalState: () => 'critical' }), { state: 'critical', can: true, hot: true });
  assert.deepEqual(thermalState({ getCurrentThermalState: () => 'serious' }), { state: 'serious', can: true, hot: true });
  assert.deepEqual(thermalState({ getCurrentThermalState: () => 'nominal' }), { state: 'nominal', can: true, hot: false });
  assert.deepEqual(thermalState({}), { state: 'unknown', can: false, hot: false });
});

test('装机壳挂上了发烫提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:thermal/);
  assert.match(main, /thermal-state-change/);
  assert.match(preload, /onThermalChanged|getThermal/);
  assert.doesNotMatch(main, /new Tray\(/);
});
