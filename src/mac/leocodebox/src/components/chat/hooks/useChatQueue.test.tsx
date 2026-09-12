import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { ServerEvent } from '../../../contexts/WebSocketContext';

import { useChatQueue } from './useChatQueue';

const item = {
  id: 'queue-1', sessionId: 'session-a', clientRequestId: 'request-1', content: 'next task',
  state: 'queued', createdAt: 1, reason: null, attachmentCount: 0,
};

async function harness(run: (read: () => ReturnType<typeof useChatQueue>, emit: (frame: ServerEvent) => void, sent: unknown[]) => Promise<void>) {
  let listener: (frame: ServerEvent) => void = () => {};
  const sent: unknown[] = [];
  const subscribe = (next: typeof listener) => { listener = next; return () => {}; };
  const sendMessage = (message: unknown) => sent.push(message);
  let current!: ReturnType<typeof useChatQueue>;
  function Harness() {
    current = useChatQueue({ sessionId: 'session-a', subscribe, sendMessage, isConnected: true });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
    await run(() => current, (frame) => act(() => listener(frame)), sent);
  } finally { await act(async () => renderer.unmount()); }
}

test('queue snapshots are visible and cancel addresses only that queued item', async () => {
  await harness(async (read, emit, sent) => {
    emit({ kind: 'chat_subscribed', sessionId: 'session-a', queueItems: [item] });
    assert.equal(read().queueItems.length, 1);
    act(() => read().cancelQueueItem('queue-1'));
    assert.deepEqual(sent.at(-1), { type: 'chat.queue.cancel', sessionId: 'session-a', queueItemId: 'queue-1' });
    emit({ kind: 'chat_queue_updated', sessionId: 'session-a', queueItems: [] });
    assert.equal(read().queueItems.length, 0);
  });
});

test('recovered queue waits for an explicit resume action', async () => {
  await harness(async (read, emit, sent) => {
    emit({ kind: 'chat_subscribed', sessionId: 'session-a', queueItems: [{ ...item, state: 'needs_confirmation', reason: 'server_restarted_during_run' }] });
    assert.equal(sent.length, 0);
    assert.equal(read().queueItems[0].state, 'needs_confirmation');
    act(() => read().resumeQueueItem('queue-1'));
    assert.deepEqual(sent.at(-1), { type: 'chat.queue.resume', sessionId: 'session-a', queueItemId: 'queue-1' });
  });
});

test('other session snapshots cannot replace the visible queue', async () => {
  await harness(async (read, emit) => {
    emit({ kind: 'chat_queue_updated', sessionId: 'session-a', queueItems: [item] });
    emit({ kind: 'chat_queue_updated', sessionId: 'session-b', queueItems: [] });
    assert.equal(read().queueItems[0].id, 'queue-1');
  });
});


test('a rejected queue action remains visible after the following authoritative snapshot', async () => {
  await harness(async (read, emit) => {
    emit({ kind: 'chat_queue_action_ack', sessionId: 'session-a', queueItemId: 'queue-1', status: 'already_started' });
    emit({ kind: 'chat_queue_updated', sessionId: 'session-a', queueItems: [] });
    assert.match(read().queueError, /已开始/);
  });
});
