import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BUSY_RATIO, loadState } from './load.js';

test('能认出机器忙不忙', () => {
  assert.equal(loadState([4], 8).busy, false);
  assert.equal(loadState([8 * BUSY_RATIO], 8).busy, true);
  assert.equal(loadState([10], 8).busy, true);
  assert.deepEqual(loadState(null, 0), { load: 0, ncpu: 0, can: false, busy: false });
});

test('装机壳挂上了忙闲提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:load/);
  assert.match(main, /loadavg|tickLoad/);
  assert.match(preload, /onLoadChanged|getLoad/);
  assert.doesNotMatch(main, /new Tray\(/);
});
