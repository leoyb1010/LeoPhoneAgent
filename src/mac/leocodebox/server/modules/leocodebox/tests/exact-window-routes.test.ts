import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createExactWindowRouter } from '../exact-window.routes.js';
import { createMacWindowDriver, type NativeWindowTransport } from '../exact-window-macos.js';
import { ExactWindowStore, WindowOperationError } from '../exact-window.js';

const observation = { app: 'Fixture', pid: 42, windowId: '7', title: 'Fixture window', bounds: '0,0,800,600', frontmost: true,
  processStartedAt: 100, onScreen: true, occluded: false, scale: 2, permissions: { accessibility: true, screenCapture: false, postEvents: true }, elements: [] };
async function serve(transport: NativeWindowTransport) {
  const app = express();
  app.use(express.json());
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  app.use('/windows', createExactWindowRouter(new ExactWindowStore(() => 2000, 'fixture'), createMacWindowDriver(transport)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}

test('native enumeration is asynchronous and does not hold unrelated requests', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const server = await serve(async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
    return { protocolVersion: 1, ok: true, windows: [observation] };
  });
  try {
    const listing = fetch(`${server.base}/windows`);
    await ready;
    assert.equal((await fetch(`${server.base}/ping`)).status, 200);
    release();
    const data = await (await listing).json() as { success: boolean; windows: Array<{ snapshot_id: string; bounds: string }> };
    assert.equal(data.success, true);
    assert.match(data.windows[0].snapshot_id, /^ws_/);
    assert.equal(data.windows[0].bounds, '0,0,800,600');
  } finally { await server.close(); }
});

test('legacy act with no action is explicitly unsupported, not successful', async () => {
  let executions = 0;
  const server = await serve(async (request) => {
    if (request.operation === 'act') executions += 1;
    return { protocolVersion: 1, ok: true, windows: [observation] };
  });
  try {
    const listing = await (await fetch(`${server.base}/windows`)).json() as { windows: Array<{ snapshot_id: string }> };
    const response = await fetch(`${server.base}/windows/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: listing.windows[0].snapshot_id, kind: 'ax' }) });
    const data = await response.json() as { success: boolean; reason: string };
    assert.equal(response.status, 501);
    assert.equal(data.success, false);
    assert.equal(data.reason, 'unsupported-action');
    assert.equal(executions, 0);
  } finally { await server.close(); }
});

test('request cancellation reaches the native operation', async () => {
  let observedSignal: AbortSignal | undefined;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const server = await serve(async (_request, options) => {
    observedSignal = options?.signal;
    entered();
    await new Promise<void>((_resolve, reject) => observedSignal?.addEventListener('abort', () => reject(new WindowOperationError('cancelled', 'cancelled')), { once: true }));
  });
  try {
    const abort = new AbortController();
    const response = fetch(`${server.base}/windows`, { signal: abort.signal }).catch(() => undefined);
    await ready;
    abort.abort();
    await response;
    for (let count = 0; count < 10 && !observedSignal?.aborted; count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(observedSignal?.aborted, true);
  } finally { await server.close(); }
});

test('capability discovery reports unavailable helper without inventing permissions', async () => {
  const server = await serve(async () => { throw new WindowOperationError('helper-unavailable', 'missing'); });
  try {
    const data = await (await fetch(`${server.base}/windows/capabilities`)).json() as { available: boolean; reason: string; permissions?: unknown };
    assert.equal(data.available, false);
    assert.equal(data.reason, 'helper-unavailable');
    assert.equal(data.permissions, undefined);
  } finally { await server.close(); }
});

test('session creation acknowledges before optional native observation and has a short deadline', () => {
  const source = readFileSync('server/modules/leophone/leophone.routes.ts', 'utf8');
  const create = source.slice(source.indexOf("router.post('/harness/sessions'"), source.indexOf("router.get('/harness/sessions/:sessionId/events'"));
  assert.ok(create.indexOf('res.status(202).json') < create.indexOf('bindFrontmostToSession('));
  assert.match(create, /void bindFrontmostToSession\(session\.sessionId, \{ timeoutMs: 750 \}\)/);
  assert.doesNotMatch(create, /await bindFrontmostToSession/);
});

test('2.0 工作台本机新建同样先 202 再异步绑定前台窗口', () => {
  const source = readFileSync('server/modules/leophone/workbench.routes.ts', 'utf8');
  const create = source.slice(source.indexOf("router.post('/leophone/local/sessions'"), source.indexOf("router.get('/leophone/local/sessions/:sessionId'"));
  assert.ok(create.indexOf('res.status(202).json') < create.indexOf('bindFrontmostToSession('));
  assert.match(create, /void bindFrontmostToSession\(session\.sessionId, \{ timeoutMs: 750 \}\)/);
  assert.doesNotMatch(create, /await bindFrontmostToSession/);
  assert.match(create, /window\.bound/);
  assert.match(source, /raiseBoundSessionWindow/);
  assert.match(source, /window\/raise/);
  assert.match(source, /clickBoundSessionWindow/);
  assert.match(source, /window\/click/);
  assert.match(source, /typeBoundSessionWindow/);
  assert.match(source, /window\/type/);
  assert.match(source, /keyBoundSessionWindow/);
  assert.match(source, /window\/key/);
  assert.match(source, /scrollBoundSessionWindow/);
  assert.match(source, /window\/scroll/);
  assert.match(source, /dragBoundSessionWindow/);
  assert.match(source, /window\/drag/);
  assert.match(source, /listBindableSessionWindows/);
  assert.match(source, /bindSessionWindow/);
  assert.match(source, /peekBoundSessionWindow/);
  assert.match(source, /window\/bind/);
  assert.match(source, /window\/peek/);
  assert.match(source, /listBoundSessionMenus/);
  assert.match(source, /menuBoundSessionWindow/);
  assert.match(source, /window\/menus/);
  assert.match(source, /window\/menu/);
});

test('装机包会带上窗口 helper,否则 /Applications 里点写按都是空的', () => {
  const prepare = readFileSync('scripts/release/prepare-desktop-app.js', 'utf8');
  const pack = readFileSync('package.json', 'utf8');
  assert.match(prepare, /native\/mac-window\/bin\/leo-window-helper/);
  assert.match(prepare, /native\/mac-window\/bin\/\*\*/);
  assert.match(pack, /build-window-helper\.mjs/);
});
