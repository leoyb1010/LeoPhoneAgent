import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { displayCount, displayShift } from './display.js';

test('能认出屏幕多了还是少了', () => {
  assert.deepEqual(displayCount({ getAllDisplays: () => [{ id: 1 }, { id: 2 }] }), { count: 2, can: true });
  assert.deepEqual(displayCount({}), { count: 0, can: false });
  assert.equal(displayShift({ count: 1 }, { count: 2 }), 'added');
  assert.equal(displayShift({ count: 2 }, { count: 1 }), 'removed');
  assert.equal(displayShift({ count: 1 }, { count: 1 }), null);
});

test('装机壳挂上了插拔屏幕提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:display/);
  assert.match(main, /display-added/);
  assert.match(preload, /onDisplayChanged/);
  assert.doesNotMatch(main, /new Tray\(/);
});
