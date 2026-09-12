import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';

import RemoteSessionPanel from './RemoteSessionPanel';

function setupBrowser() {
  const previous = globalThis.window;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  } });
  return {
    retry: () => { const [id, callback] = [...timers.entries()][0]; timers.delete(id); callback(); },
    restore: () => Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }),
  };
}

function eventStream() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  return {
    response: new Response(body),
    send: (...frames: Record<string, unknown>[]) => source.enqueue(new TextEncoder().encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    )),
    end: () => source.close(),
  };
}

async function renderPanel(scroll: { scrollTop: number; scrollHeight: number; clientHeight: number; scrollTo: (options: { top: number }) => void }) {
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: {} } }, initImmediate: false });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nextProvider i18n={i18n}><RemoteSessionPanel target={{ machine: 'Fixture Mac', sessionId: 'session-1' }} onClose={() => undefined} /></I18nextProvider>,
      { createNodeMock: (element) => String(element.props.className ?? '').includes('wb-log-surface') ? scroll : null },
    );
  });
  return renderer;
}

const log = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.find(
  (node) => typeof node.type === 'string' && String(node.props.className ?? '').includes('wb-log-surface'),
);
const input = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByType('input');
const enter = { key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: () => undefined };

test('the 400-line window retains row identity and keeps following after the cap', async (t) => {
  const browser = setupBrowser();
  const stream = eventStream();
  t.mock.method(apiClient, 'raw', async () => stream.response);
  const positions: number[] = [];
  const scroll = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, scrollTo: ({ top }: { top: number }) => { positions.push(top); } };
  const renderer = await renderPanel(scroll);
  try {
    await act(async () => stream.send(...Array.from({ length: 400 }, (_, index) => ({ event: 'message.delta', seq: index + 1, delta: `Line ${index + 1}` }))));
    const retained = log(renderer).findAllByType('div').find((node) => node.children[0] === 'Line 2');
    positions.length = 0;
    scroll.scrollHeight = 1020;
    await act(async () => stream.send({ event: 'message.delta', seq: 401, delta: 'Line 401' }));
    const after = log(renderer).findAllByType('div').find((node) => node.children[0] === 'Line 2');
    assert.ok(after === retained, 'removing the first row must not remount the other 399 rows');
    assert.equal(log(renderer).children.length, 400);
    assert.equal(positions.at(-1), 1020, 'a new sequence follows even while length remains 400');
  } finally { act(() => renderer.unmount()); browser.restore(); }
});

test('reading older output pauses following and offers an explicit return to latest', async (t) => {
  const browser = setupBrowser();
  const stream = eventStream();
  t.mock.method(apiClient, 'raw', async () => stream.response);
  const positions: number[] = [];
  const scroll = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, scrollTo: ({ top }: { top: number }) => positions.push(top) };
  const renderer = await renderPanel(scroll);
  try {
    await act(async () => stream.send({ event: 'message.delta', seq: 1, delta: 'First' }));
    positions.length = 0;
    scroll.scrollTop = 100;
    assert.equal(typeof log(renderer).props.onScroll, 'function', 'reader intent must be observed');
    act(() => log(renderer).props.onScroll({ currentTarget: scroll }));
    await act(async () => stream.send({ event: 'message.delta', seq: 2, delta: 'Second' }));
    assert.equal(positions.length, 0, 'incoming output must not pull the reader to bottom');
    const latest = renderer.root.findAllByType('button').find((button) => button.props['data-remote-latest']);
    assert.ok(latest, 'a user can explicitly resume following');
    act(() => latest.props.onClick());
    assert.equal(positions.at(-1), 1000);
  } finally { act(() => renderer.unmount()); browser.restore(); }
});

test('a successful reconnect clears the stale transport error', async (t) => {
  const browser = setupBrowser();
  const stream = eventStream();
  let requests = 0;
  t.mock.method(apiClient, 'raw', async () => {
    if (++requests === 1) throw new Error('Connection lost');
    return stream.response;
  });
  const renderer = await renderPanel({ scrollTop: 0, scrollHeight: 0, clientHeight: 500, scrollTo: () => undefined });
  try {
    assert.equal(renderer.root.findAll((node) => node.props.role === 'alert').length, 1);
    await act(async () => browser.retry());
    assert.equal(requests, 2);
    assert.equal(renderer.root.findAll((node) => node.props.role === 'alert').length, 0);
  } finally { act(() => renderer.unmount()); browser.restore(); }
});

test('rapid Enter submits once and a successful send preserves text typed while waiting', async (t) => {
  const browser = setupBrowser();
  const stream = eventStream();
  t.mock.method(apiClient, 'raw', async () => stream.response);
  let finish!: (value: unknown) => void;
  const sent: unknown[] = [];
  t.mock.method(apiClient, 'post', async (_url: string, body?: unknown) => {
    sent.push(body);
    return await new Promise((resolve) => { finish = resolve; });
  });
  const renderer = await renderPanel({ scrollTop: 0, scrollHeight: 0, clientHeight: 500, scrollTo: () => undefined });
  try {
    act(() => input(renderer).props.onChange({ target: { value: 'First request' } }));
    act(() => { input(renderer).props.onKeyDown(enter); input(renderer).props.onKeyDown(enter); });
    assert.equal(sent.length, 1, 'duplicate Enter must not duplicate a remote action');
    act(() => input(renderer).props.onChange({ target: { value: 'Next draft' } }));
    await act(async () => finish({ ok: true }));
    assert.equal(input(renderer).props.value, 'Next draft');
  } finally { act(() => renderer.unmount()); browser.restore(); }
});

test('journal status is opt-in and durability control frames never become output rows', async (t) => {
  const browser = setupBrowser();
  const stream = eventStream();
  let requestedUrl = '';
  t.mock.method(apiClient, 'raw', async (url: string) => { requestedUrl = url; return stream.response; });
  const renderer = await renderPanel({ scrollTop: 0, scrollHeight: 0, clientHeight: 500, scrollTo: () => undefined });
  try {
    assert.ok(requestedUrl.includes('journal_status=1'));
    assert.equal(renderer.root.findByProps({ 'data-remote-durability': 'unknown' }).props.role, 'status');
    await act(async () => stream.send(
      { event: 'message.delta', seq: 1, delta: 'Output', durability: 'pending' },
      { type: 'durability', state: 'degraded', durable_seq: 0, latest_seq: 1, pending_bytes: 12, error: 'ENOSPC', missing_ranges: [{ from: 1, to: 1, reason: 'write-failed' }] },
    ));
    assert.equal(log(renderer).children.length, 1);
    assert.ok(renderer.root.findByProps({ 'data-remote-durability': 'degraded' }));
    await act(async () => stream.send({ type: 'durability', state: 'durable', durable_seq: 1, latest_seq: 1, pending_bytes: 0, missing_ranges: [] }));
    assert.equal(log(renderer).children.length, 1);
    assert.ok(renderer.root.findByProps({ 'data-remote-durability': 'durable' }));
  } finally { act(() => renderer.unmount()); browser.restore(); }
});
