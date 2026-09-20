import assert from 'node:assert/strict';
import test from 'node:test';

import { createMacWindowDriver, raiseBoundSessionWindow } from '../exact-window-macos.js';
import { ExactWindowStore, parseWindowAction, type WindowObservation, type WindowActionReceipt } from '../exact-window.js';

const observation: WindowObservation = {
  app: 'Fixture', pid: 42, windowId: '7', title: 'Fixture window', bounds: '0,0,800,600', frontmost: true,
  processStartedAt: 100, bundleId: 'test.fixture', onScreen: true, occluded: false, scale: 2,
  permissions: { accessibility: true, screenCapture: false, postEvents: true }, elements: [], stateHash: 'fixture-state',
};
const receipt: WindowActionReceipt = { attempted: true, verified: true, verification: 'minimized-readback', action: 'minimize', observedAt: 2000 };

test('action parser rejects missing actions, arbitrary kinds/code, bad paths and coordinates', () => {
  assert.equal(parseWindowAction('ax', undefined), null);
  assert.equal(parseWindowAction('shell', { name: 'focus' }), null);
  assert.equal(parseWindowAction('ax', { name: 'eval', script: 'danger()' }), null);
  assert.equal(parseWindowAction('menu', { name: 'select', path: ['File', {}] }), null);
  assert.equal(parseWindowAction('coord', { name: 'click', x: Number.NaN, y: 0.5, coordinateSpace: 'normalized-window' }), null);
  assert.equal(parseWindowAction('coord', { name: 'click', x: 800, y: 600 }), null);
  assert.deepEqual(parseWindowAction('ax', { name: 'setValue', elementId: 'control', value: 'plain text' }), { name: 'setValue', elementId: 'control', value: 'plain text' });
});

test('re-observation uses live native data and retains bindings only for the same window identity', async () => {
  const store = new ExactWindowStore(() => 2000, 'test');
  const captured = store.capture(observation);
  store.bindSession('hs', captured.snapshotId);
  const requests: unknown[] = [];
  const driver = createMacWindowDriver(async (request) => {
    requests.push(request);
    return { protocolVersion: 1, ok: true, observation: { ...observation, title: 'Updated live title' } };
  });
  const observed = await store.observe(captured.snapshotId, driver);
  assert.equal(observed.ref.title, 'Updated live title');
  assert.equal(store.summary('hs')?.snapshot_id, observed.snapshotId);
  assert.equal(requests.length, 1);
  const replaced = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, observation: { ...observation, processStartedAt: 101 } }));
  await assert.rejects(store.observe(observed.snapshotId, replaced), /身份|changed/);
  assert.equal(store.summary('hs')?.snapshot_id, observed.snapshotId);
});

test('native permission refusal never renews a snapshot or returns action success', async () => {
  const store = new ExactWindowStore(() => 2000, 'test');
  const captured = store.capture(observation);
  const driver = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: false, reason: 'permission-denied', message: 'Accessibility permission was revoked' }));
  const result = await store.act(captured.snapshotId, 'ax', { name: 'minimize' }, driver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'permission-denied');
  assert.equal(store.get(captured.snapshotId), captured);
});

test('only a verified native result produces an action receipt and replacement snapshot', async () => {
  const store = new ExactWindowStore(() => 2000, 'test');
  const captured = store.capture(observation);
  const driver = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, observation, receipt: { ...receipt, verified: false } }));
  const unknown = await store.act(captured.snapshotId, 'ax', { name: 'minimize' }, driver);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) { assert.equal(unknown.reason, 'verification-failed'); assert.equal(unknown.receipt?.attempted, true); }
  const verified = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, observation: { ...observation, frontmost: false }, receipt }));
  const result = await store.act(captured.snapshotId, 'ax', { name: 'minimize' }, verified);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.snapshot.frontmost, false); assert.equal(result.receipt.verification, 'minimized-readback'); }
});

test('raiseBoundSessionWindow 过期快照也会按 pid 再认一次再 focus', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture(observation);
  store.bindSession('hs_raise', captured.snapshotId);
  const driver = createMacWindowDriver(async () => ({
    protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true },
    receipt: { attempted: true, verified: true, verification: 'focused-readback', action: 'focus', observedAt: 10_000 },
  }));
  const result = await raiseBoundSessionWindow('hs_raise', undefined, store, driver, async () => [observation]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.app, 'Fixture');
  const missing = await raiseBoundSessionWindow('hs_none', undefined, store, driver, async () => [observation]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'unknown-snapshot');
  const gone = await raiseBoundSessionWindow('hs_raise', undefined, store, driver, async () => []);
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.reason, 'window-gone');
});

test('malformed native IPC output cannot enter the snapshot store', async () => {
  const driver = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, windows: [{ ...observation, pid: -1 }] }));
  await assert.rejects(driver.list(), /native|invalid|无效/i);
});
