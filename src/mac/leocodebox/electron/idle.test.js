import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { idleCameBack, idleProbe } from './idle.js';

test('能认出走开和回来', () => {
  assert.deepEqual(idleProbe({ getSystemIdleState: () => 'idle' }), { state: 'idle', can: true, idle: true });
  assert.deepEqual(idleProbe({ getSystemIdleState: () => 'active' }), { state: 'active', can: true, idle: false });
  assert.deepEqual(idleProbe({ getSystemIdleState: () => 'locked' }), { state: 'locked', can: true, idle: false });
  assert.deepEqual(idleProbe({}), { state: 'unknown', can: false, idle: false });
  assert.equal(idleCameBack({ idle: true }, { state: 'active' }), true);
  assert.equal(idleCameBack({ idle: false, state: 'locked' }, { state: 'active' }), false);
  assert.equal(idleCameBack({ idle: true }, { state: 'idle' }), false);
});

test('装机壳挂上了走开提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:idle-back/);
  assert.match(main, /getSystemIdleState/);
  assert.match(preload, /onIdleBack/);
  assert.doesNotMatch(main, /new Tray\(/);
});
