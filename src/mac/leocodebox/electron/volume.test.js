import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readVolumeDir, volumeCount, volumeShift } from './volume.js';

test('能认出磁盘多了还是少了', () => {
  assert.deepEqual(volumeCount(['Macintosh HD', 'USB']), { count: 2, can: true, names: ['Macintosh HD', 'USB'] });
  assert.deepEqual(volumeCount(null), { count: 0, can: false, names: [] });
  assert.equal(volumeShift({ count: 1 }, { count: 2 }), 'added');
  assert.equal(volumeShift({ count: 2 }, { count: 1 }), 'removed');
  assert.equal(volumeShift({ count: 1 }, { count: 1 }), null);
  assert.deepEqual(readVolumeDir(() => ['Macintosh HD']), ['Macintosh HD']);
  assert.equal(readVolumeDir(null), null);
});

test('装机壳挂上了插拔磁盘提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:volume/);
  assert.match(main, /NSWorkspaceDidMountNotification|tickVolume/);
  assert.match(preload, /onVolumeChanged/);
  assert.doesNotMatch(main, /new Tray\(/);
});
