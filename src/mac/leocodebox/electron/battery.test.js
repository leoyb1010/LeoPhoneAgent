import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { batteryState } from './battery.js';

test('能认出是不是用电池', () => {
  assert.deepEqual(batteryState({ isOnBatteryPower: () => true }), { on: true, can: true });
  assert.deepEqual(batteryState({ isOnBatteryPower: () => false }), { on: false, can: true });
  assert.deepEqual(batteryState({}), { on: false, can: false });
});

test('装机壳挂上了电池提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:battery/);
  assert.match(main, /on-battery/);
  assert.match(preload, /onBatteryChanged|getBattery/);
  assert.doesNotMatch(main, /new Tray\(/);
});
