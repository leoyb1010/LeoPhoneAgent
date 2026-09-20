import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LOW_FREE_KB, memoryState } from './memory.js';

test('能认出内存紧不紧', () => {
  assert.equal(memoryState({ total: 16 * 1024 * 1024, free: 8 * 1024 * 1024 }).low, false);
  assert.equal(memoryState({ total: 16 * 1024 * 1024, free: LOW_FREE_KB - 1 }).low, true);
  assert.equal(memoryState({ total: 8 * 1024 * 1024, free: 200 * 1024 }).low, true);
  assert.deepEqual(memoryState({}), { free: 0, total: 0, can: false, low: false });
});

test('装机壳挂上了内存提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:memory/);
  assert.match(main, /getSystemMemoryInfo|tickMemory/);
  assert.match(preload, /onMemoryChanged|getMemory/);
  assert.doesNotMatch(main, /new Tray\(/);
});
