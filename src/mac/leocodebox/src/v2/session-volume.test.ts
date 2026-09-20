import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { volumeAddedToast, volumeChangeToast, volumeRemovedToast } from './session-volume';

test('能说出磁盘插上还是拔掉', () => {
  assert.match(volumeAddedToast(), /插上/);
  assert.match(volumeRemovedToast(), /拔掉/);
  assert.equal(volumeChangeToast('removed'), volumeRemovedToast());
  assert.equal(volumeChangeToast('added'), volumeAddedToast());
});

test('2.0 壳接上了插拔磁盘提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /volumeChangeToast/);
  assert.match(app, /onVolumeChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /磁盘|volumeChangeToast/);
});
