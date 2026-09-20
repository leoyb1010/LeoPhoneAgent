import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canPlayDoneChime,
  chimesFromSnapshot,
  doneChimeLabel,
  doneChimeToast,
  readDoneChimeOn,
  shouldPlayDoneChime,
} from './session-chime';

test('跑完才响，启动时不响', () => {
  assert.equal(shouldPlayDoneChime('running', 'idle'), true);
  assert.equal(shouldPlayDoneChime('starting', 'waiting_for_approval'), true);
  assert.equal(shouldPlayDoneChime('running', 'failed'), true);
  assert.equal(shouldPlayDoneChime('running', 'running'), false);
  assert.equal(shouldPlayDoneChime('idle', 'running'), false);
  assert.equal(shouldPlayDoneChime(null, 'idle'), false);
  assert.equal(readDoneChimeOn(null), true);
  assert.equal(readDoneChimeOn('false'), false);
  assert.equal(canPlayDoneChime(null), false);
  assert.equal(canPlayDoneChime({ playDoneSound: async () => ({ ok: true }) }), true);
  assert.match(doneChimeToast(true), /跑完响一声/);
  assert.match(doneChimeToast(false), /关掉/);
  assert.equal(doneChimeLabel(false), '跑完响一声');
  assert.equal(doneChimeLabel(true), '跑完不要响');
  const primed = chimesFromSnapshot({
    primed: true,
    prev: new Map([['local:a', 'running']]),
    next: [{ key: 'local:a', machine: 'local', status: 'idle' }],
  });
  assert.equal(primed.count, 1);
  const cold = chimesFromSnapshot({
    primed: false,
    prev: new Map(),
    next: [{ key: 'local:a', machine: 'local', status: 'idle' }],
  });
  assert.equal(cold.count, 0);
});

test('2.0 壳接上了跑完响一声，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canPlayDoneChime/);
  assert.match(app, /chimesFromSnapshot|playSessionChime/);
  assert.match(main, /leocodebox-desktop:play-done-sound/);
  assert.match(main, /\/usr\/bin\/afplay/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /跑完响一声|跑完不要响/);
});
