import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { bindSessionWindow, clickBoundSessionWindow, createMacWindowDriver, dragBoundSessionWindow, keyBoundSessionWindow, listBindableSessionWindows, listBoundSessionMenus, menuBoundSessionWindow, peekBoundSessionWindow, raiseBoundSessionWindow, readBoundSessionWindow, scrollBoundSessionWindow, typeBoundSessionWindow } from '../exact-window-macos.js';
import { ExactWindowStore, clipWindowReadText, isOwnMacWindow, parseNormalizedClickPoint, parseWindowAction, parseWindowDrag, parseWindowMenuPath, parseWindowNamedKey, parseWindowScroll, parseWindowTypeText, pickBindableWindow, pickUsableWindowMenus, pickWritableWindowField, type WindowElement, type WindowObservation, type WindowActionReceipt } from '../exact-window.js';

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
  assert.equal(parseWindowAction('coord', { name: 'scroll', x: 0.5, y: 0.5, dy: 0, coordinateSpace: 'normalized-window' }), null);
  assert.deepEqual(parseWindowScroll(0.5, 0.4, undefined, -3), { x: 0.5, y: 0.4, dy: -3 });
  assert.equal(parseWindowDrag(0.4, 0.4, 0.4, 0.4), null);
  assert.deepEqual(parseWindowDrag(0.2, 0.3, 0.7, 0.8), { x: 0.2, y: 0.3, x2: 0.7, y2: 0.8 });
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

test('readBoundSessionWindow 先提到前面再读焦点框,没有框不会动手', async () => {
  assert.equal(clipWindowReadText('hello'), 'hello');
  assert.equal(clipWindowReadText('x'.repeat(5000)).length, 4096);
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture(observation);
  store.bindSession('hs_read', captured.snapshotId);
  const kinds: string[] = [];
  const withFields = { ...observation, frontmost: true, elements: [{ ...writable, value: '已经写好的字' }, other] };
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'observe') return { protocolVersion: 1, ok: true, observation: withFields };
    if (request.operation === 'act') {
      kinds.push(String(request.kind));
      return {
        protocolVersion: 1, ok: true, observation: withFields,
        receipt: { attempted: true, verified: true, verification: 'focused-readback', action: 'focus', observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [withFields] };
  });
  const listed = async () => [withFields];
  const emptyStore = new ExactWindowStore(() => 10_000, 'test');
  emptyStore.capture(observation);
  emptyStore.bindSession('hs_empty', emptyStore.capture({ ...observation, elements: [] }).snapshotId);
  const none = await readBoundSessionWindow('hs_empty', undefined, undefined, emptyStore, createMacWindowDriver(async (request) => {
    if (request.operation === 'observe') return { protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true, elements: [] } };
    if (request.operation === 'act') {
      return {
        protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true, elements: [] },
        receipt: { attempted: true, verified: true, verification: 'focused-readback', action: 'focus', observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [{ ...observation, frontmost: true }] };
  }), async () => [{ ...observation, frontmost: true }]);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reason, 'element-unavailable');
  const result = await readBoundSessionWindow('hs_read', undefined, undefined, store, driver, listed);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.elementId, 'field-1');
    assert.equal(result.text, '已经写好的字');
  }
  assert.deepEqual(kinds, ['ax']);
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

test('自动绑跳过自己,工作台按快照绑并能读到画面', async () => {
  assert.equal(isOwnMacWindow({ app: 'leocodebox', bundleId: 'com.leoyuan.leocodebox', pid: 1 }), true);
  assert.equal(isOwnMacWindow({ app: 'Finder', bundleId: 'com.apple.finder', pid: 99 }), false);
  const own = { ...observation, app: 'leocodebox', bundleId: 'com.leoyuan.leocodebox', pid: process.pid, frontmost: true };
  const other = { ...observation, app: 'Finder', title: 'Documents', pid: 88, windowId: '9', bundleId: 'com.apple.finder', frontmost: false };
  assert.equal(pickBindableWindow([own, other])?.app, 'Finder');
  const store = new ExactWindowStore(() => 10_000, 'test');
  const listed = async () => [own, other];
  const rows = await listBindableSessionWindows(undefined, store, listed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.app, 'Finder');
  const bound = await bindSessionWindow('hs_bind', rows[0]?.snapshotId, undefined, store, listed);
  assert.equal(bound.ok, true);
  if (bound.ok) assert.equal(bound.app, 'Finder');
  const self = await bindSessionWindow('hs_bind', store.capture(own).snapshotId, undefined, store, listed);
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.reason, 'invalid-request');
  const jpeg = Buffer.from('fake-jpeg');
  const data = jpeg.toString('base64');
  const hash = createHash('sha256').update(jpeg).digest('hex');
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'observe') {
      return {
        protocolVersion: 1, ok: true,
        observation: { ...other, frontmost: true, image: { mimeType: 'image/jpeg', data, width: 8, height: 6, scaleX: 1, scaleY: 1, hash } },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [other] };
  });
  const peeked = await peekBoundSessionWindow('hs_bind', undefined, store, driver, listed);
  assert.equal(peeked.ok, true);
  if (peeked.ok) {
    assert.equal(peeked.app, 'Finder');
    assert.equal(peeked.image?.data, data);
  }
});

test('scrollBoundSessionWindow 和 dragBoundSessionWindow 先提到前面再动手,坏手势不会执行', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture({ ...observation, frontmost: false });
  store.bindSession('hs_hid', captured.snapshotId);
  const names: string[] = [];
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'act') {
      names.push(String((request.action as { name?: string }).name));
      return {
        protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true },
        receipt: { attempted: true, verified: true, verification: 'posted', action: String((request.action as { name?: string }).name), observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [{ ...observation, frontmost: true }] };
  });
  const listed = async () => [{ ...observation, frontmost: true }];
  const badScroll = await scrollBoundSessionWindow('hs_hid', 0.5, 0.5, 0, 0, undefined, store, driver, listed);
  assert.equal(badScroll.ok, false);
  if (!badScroll.ok) assert.equal(badScroll.reason, 'invalid-request');
  const badDrag = await dragBoundSessionWindow('hs_hid', 0.4, 0.4, 0.4, 0.4, undefined, store, driver, listed);
  assert.equal(badDrag.ok, false);
  if (!badDrag.ok) assert.equal(badDrag.reason, 'invalid-request');
  assert.deepEqual(names, []);
  const scrolled = await scrollBoundSessionWindow('hs_hid', 0.5, 0.4, undefined, -3, undefined, store, driver, listed);
  assert.equal(scrolled.ok, true);
  if (scrolled.ok) assert.equal(scrolled.dy, -3);
  const dragged = await dragBoundSessionWindow('hs_hid', 0.2, 0.3, 0.7, 0.8, undefined, store, driver, listed);
  assert.equal(dragged.ok, true);
  if (dragged.ok) assert.equal(dragged.x2, 0.7);
  assert.deepEqual(names, ['focus', 'scroll', 'focus', 'drag']);
});

test('菜单路径只要 2 到 6 段,关掉的和单级的不进可用列表', () => {
  assert.deepEqual(parseWindowMenuPath(['文件', '存储']), ['文件', '存储']);
  assert.equal(parseWindowMenuPath(['文件']), null);
  assert.equal(parseWindowMenuPath([]), null);
  assert.deepEqual(pickUsableWindowMenus([
    { path: ['文件'], enabled: true },
    { path: ['文件', '存储'], enabled: true },
    { path: ['编辑', '剪切'], enabled: false },
    { path: ['编辑', '拷贝'], enabled: true },
  ]), [{ path: ['文件', '存储'] }, { path: ['编辑', '拷贝'] }]);
});

test('listBoundSessionMenus 和 menuBoundSessionWindow 先核对菜单再执行', async () => {
  const store = new ExactWindowStore(() => 10_000, 'test');
  const captured = store.capture({ ...observation, menus: [{ path: ['File', 'Save'], enabled: true }] });
  store.bindSession('hs_menu', captured.snapshotId);
  const kinds: string[] = [];
  const driver = createMacWindowDriver(async (request) => {
    if (request.operation === 'observe') {
      return {
        protocolVersion: 1, ok: true,
        observation: { ...observation, frontmost: true, menus: [{ path: ['File', 'Save'], enabled: true }, { path: ['Edit', 'Cut'], enabled: false }] },
      };
    }
    if (request.operation === 'act') {
      kinds.push(String(request.kind));
      return {
        protocolVersion: 1, ok: true, observation: { ...observation, frontmost: true },
        receipt: { attempted: true, verified: true, verification: 'menu-action-result', action: 'select', observedAt: 10_000 },
      };
    }
    return { protocolVersion: 1, ok: true, windows: [{ ...observation, frontmost: true }] };
  });
  const listed = async () => [{ ...observation, frontmost: true }];
  const menus = await listBoundSessionMenus('hs_menu', undefined, store, driver, listed);
  assert.equal(menus.ok, true);
  if (menus.ok) assert.deepEqual(menus.menus, [{ path: ['File', 'Save'] }]);
  const bad = await menuBoundSessionWindow('hs_menu', ['File'], undefined, store, driver, listed);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'invalid-request');
  const missing = await menuBoundSessionWindow('hs_menu', ['Edit', 'Cut'], undefined, store, driver, listed);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'element-unavailable');
  assert.ok(!kinds.includes('menu'));
  kinds.length = 0;
  const selected = await menuBoundSessionWindow('hs_menu', ['File', 'Save'], undefined, store, driver, listed);
  assert.equal(selected.ok, true);
  if (selected.ok) assert.deepEqual(selected.path, ['File', 'Save']);
  assert.deepEqual(kinds, ['ax', 'menu']);
});

test('malformed native IPC output cannot enter the snapshot store', async () => {
  const driver = createMacWindowDriver(async () => ({ protocolVersion: 1, ok: true, windows: [{ ...observation, pid: -1 }] }));
  await assert.rejects(driver.list(), /native|invalid|无效/i);
});
