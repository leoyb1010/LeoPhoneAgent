import assert from 'node:assert/strict';
import test from 'node:test';

import { clickBoundSessionWindow, createMacWindowDriver, keyBoundSessionWindow, raiseBoundSessionWindow, typeBoundSessionWindow } from '../exact-window-macos.js';
import { ExactWindowStore, parseNormalizedClickPoint, parseWindowAction, parseWindowNamedKey, parseWindowTypeText, pickWritableWindowField, type WindowElement, type WindowObservation, type WindowActionReceipt } from '../exact-window.js';

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
  assert.equal(parseNormalizedClickPoint(0, 0.5), null);
  assert.equal(parseNormalizedClickPoint('1', '0.2'), null);
  assert.deepEqual(parseNormalizedClickPoint('0.4', '0.6'), { x: 0.4, y: 0.6 });
  assert.equal(parseWindowAction('key', { name: 'key', key: 'command' }), null);
  assert.deepEqual(parseWindowAction('key', { name: 'key', key: 'return' }), { name: 'key', key: 'return' });
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

test('clickBoundSessionWindow 先提到前面再按相对坐标点,坏坐标不会动手', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture({ ...observation, frontmost: false });
  store.bindSession('hs_click', captured.snapshotId);
  const kinds: string[] = [];
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'act') {
      kinds.push(String(request.kind));
      const action = request.action as { name?: string };
      return {
        protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true },
        receipt: { attempted: true, verified: true, verification: action.name === 'click' ? 'clicked-readback' : 'focused-readback', action: String(action.name), observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [{ ...observation, frontmost: true }] };
  });
  const listed = async () => [{ ...observation, frontmost: true }];
  const bad = await clickBoundSessionWindow('hs_click', 1.5, 0.5, undefined, store, driver, listed);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'invalid-request');
  assert.deepEqual(kinds, []);
  const result = await clickBoundSessionWindow('hs_click', 0.4, 0.6, undefined, store, driver, listed);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.app, 'Fixture');
    assert.equal(result.x, 0.4);
    assert.equal(result.y, 0.6);
  }
  assert.deepEqual(kinds, ['ax', 'coord']);
  const missing = await clickBoundSessionWindow('hs_none', 0.4, 0.6, undefined, store, driver, listed);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'unknown-snapshot');
});

const writable: WindowElement = {
  id: 'field-1', path: [0, 1], role: 'AXTextField', bounds: '10,10,120,24',
  enabled: true, settableValue: true, redacted: false, actions: ['AXSetValue'], focused: true, title: 'Name',
};
const other: WindowElement = {
  id: 'field-2', path: [0, 2], role: 'AXTextArea', bounds: '10,40,120,48',
  enabled: true, settableValue: true, redacted: false, actions: ['AXSetValue'],
};

test('pickWritableWindowField 优先指定 id,否则焦点,否则第一个能写的框', () => {
  assert.equal(parseWindowTypeText(''), null);
  assert.equal(parseWindowTypeText('x'.repeat(4097)), null);
  assert.equal(parseWindowTypeText('hello'), 'hello');
  assert.equal(pickWritableWindowField(undefined), null);
  assert.equal(pickWritableWindowField([{ ...writable, redacted: true, focused: false }]), null);
  assert.equal(pickWritableWindowField([other, writable])?.id, 'field-1');
  assert.equal(pickWritableWindowField([other, writable], 'field-2')?.id, 'field-2');
  assert.equal(pickWritableWindowField([other, writable], 'gone'), null);
});

test('typeBoundSessionWindow 先提到前面再写入焦点框,空字不会动手', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture(observation);
  store.bindSession('hs_type', captured.snapshotId);
  const names: string[] = [];
  const withFields = { ...observation, frontmost: true, elements: [other, writable] };
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'observe') return { protocolVersion: 1, ok: true, observation: withFields };
    if (request.operation === 'act') {
      names.push(String((request.action as { name?: string }).name));
      return {
        protocolVersion: 1, ok: true, observation: withFields,
        receipt: { attempted: true, verified: true, verification: 'value-readback', action: String((request.action as { name?: string }).name), observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [withFields] };
  });
  const listed = async () => [withFields];
  const empty = await typeBoundSessionWindow('hs_type', '', undefined, undefined, store, driver, listed);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'invalid-request');
  assert.deepEqual(names, []);
  const result = await typeBoundSessionWindow('hs_type', 'hello', undefined, undefined, store, driver, listed);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.elementId, 'field-1');
  assert.deepEqual(names, ['focus', 'setValue']);
  const missing = await typeBoundSessionWindow('hs_none', 'hello', undefined, undefined, store, driver, listed);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'unknown-snapshot');
});

test('keyBoundSessionWindow 先提到前面再打具名键,未知键不会动手', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture({ ...observation, frontmost: false });
  store.bindSession('hs_key', captured.snapshotId);
  const kinds: string[] = [];
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'act') {
      kinds.push(String(request.kind));
      const action = request.action as { name?: string; key?: string };
      return {
        protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true },
        receipt: { attempted: true, verified: true, verification: action.name === 'key' ? 'key-posted' : 'focused-readback', action: String(action.name), observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [{ ...observation, frontmost: true }] };
  });
  const listed = async () => [{ ...observation, frontmost: true }];
  assert.equal(parseWindowNamedKey('command'), null);
  assert.equal(parseWindowNamedKey('return'), 'return');
  assert.equal(parseWindowAction('key', { name: 'key', key: 'enter' }), null);
  const bad = await keyBoundSessionWindow('hs_key', 'enter', undefined, store, driver, listed);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'invalid-request');
  assert.deepEqual(kinds, []);
  const result = await keyBoundSessionWindow('hs_key', 'return', undefined, store, driver, listed);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.key, 'return');
  assert.deepEqual(kinds, ['ax', 'key']);
  const missing = await keyBoundSessionWindow('hs_none', 'return', undefined, store, driver, listed);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'unknown-snapshot');
});

test('malformed native IPC output cannot enter the snapshot store', async () => {
  const driver = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, windows: [{ ...observation, pid: -1 }] }));
  await assert.rejects(driver.list(), /native|invalid|无效/i);
});
