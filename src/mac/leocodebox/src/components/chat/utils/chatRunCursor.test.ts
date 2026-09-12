import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceChatCursor } from './chatRunCursor';

test('a new run resets the replay cursor even when its numeric sequence is lower', () => {
  const next = advanceChatCursor({ runId: 'old', seq: 1000 }, {
    kind: 'chat_subscribed', cursor: { runId: 'new', seq: 50 }, replayFrom: 0, replayReset: true,
  });
  assert.equal(next.reset, true);
  assert.deepEqual(next.cursor, { runId: 'new', seq: 0 });
  assert.equal(advanceChatCursor(next.cursor, { kind: 'stream_delta', runId: 'new', seq: 1 }).accept, true);
});

test('subscription ack must not skip the events it is about to replay', () => {
  const next = advanceChatCursor({ runId: 'run', seq: 5 }, {
    kind: 'chat_subscribed', cursor: { runId: 'run', seq: 20 }, replayFrom: 5,
  });
  assert.deepEqual(next.cursor, { runId: 'run', seq: 5 });
  assert.equal(advanceChatCursor(next.cursor, { kind: 'stream_delta', runId: 'run', seq: 6 }).accept, true);
});

test('duplicate or older frames from the same run do not append text twice', () => {
  assert.equal(advanceChatCursor({ runId: 'run', seq: 5 }, { kind: 'stream_delta', runId: 'run', seq: 5 }).accept, false);
  assert.equal(advanceChatCursor({ runId: 'run', seq: 5 }, { kind: 'stream_delta', runId: 'run', seq: 3 }).accept, false);
});

test('legacy frames without runId remain compatible', () => {
  const next = advanceChatCursor(undefined, { kind: 'stream_delta', seq: 1 });
  assert.equal(next.accept, true);
  assert.equal(next.reset, false);
});

test('a restarted server with no active run clears the obsolete cursor', () => {
  const next = advanceChatCursor({ runId: 'dead-process', seq: 100 }, {
    kind: 'chat_subscribed', cursor: null, replayReset: true, isProcessing: false,
  });
  assert.equal(next.reset, true);
  assert.equal(next.cursor, undefined);
});
