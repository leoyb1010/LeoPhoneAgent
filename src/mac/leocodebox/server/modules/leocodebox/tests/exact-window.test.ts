import assert from 'node:assert/strict';
import test from 'node:test';

import { ExactWindowStore, WINDOW_SNAPSHOT_FRESH_MS } from '../exact-window.js';

function storeAt(start = 1_000): { store: ExactWindowStore; now: { t: number } } {
  const now = { t: start };
  return { store: new ExactWindowStore(() => now.t, 'test-mac'), now };
}

function snap(store: ExactWindowStore, frontmost = true) {
  return store.capture({
    app: 'Cursor',
    pid: 4242,
    windowId: '12',
    title: 'LeoPhoneAgent',
    frontmost,
    bounds: '0,0,800,600',
  });
}

test('bind is machine+app+pid+window+snapshot', () => {
  const { store } = storeAt();
  const captured = snap(store);
  store.bindSession('hs_1', captured.snapshotId);
  const summary = store.summary('hs_1');
  assert.deepEqual(summary, {
    machine: 'test-mac',
    app: 'Cursor',
    pid: 4242,
    window_id: '12',
    title: 'LeoPhoneAgent',
    snapshot_id: captured.snapshotId,
    frontmost: true,
    stale: false,
  });
});

test('stale snapshot refuses the next action', () => {
  const { store, now } = storeAt();
  const captured = snap(store, false);
  now.t += WINDOW_SNAPSHOT_FRESH_MS + 1;
  const result = store.act(captured.snapshotId, 'ax');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'snapshot-expired');
    assert.match(result.message, /重观察/);
  }
});

test('fresh frontmost action re-observes', () => {
  const { store } = storeAt();
  const captured = snap(store, true);
  store.bindSession('hs_1', captured.snapshotId);
  const result = store.act(captured.snapshotId, 'menu');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.notEqual(result.snapshot.snapshotId, captured.snapshotId);
    assert.equal(store.summary('hs_1')?.snapshot_id, result.snapshot.snapshotId);
  }
});

test('coordinate click on a background window is blocked', () => {
  const { store } = storeAt();
  const captured = snap(store, false);
  const result = store.act(captured.snapshotId, 'coord');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'background-blocked');
});
