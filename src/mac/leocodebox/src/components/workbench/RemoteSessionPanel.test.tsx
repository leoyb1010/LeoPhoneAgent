import assert from 'node:assert/strict';
import test from 'node:test';

import { applyApprovalFrame, describeRemoteEvent, readRemoteSse } from './remoteSessionEvents';

test('remote event parser follows the harness event contract', () => {
  assert.deepEqual(
    describeRemoteEvent({ event: 'message.delta', seq: 7, delta: 'hello' }),
    { seq: 7, text: 'hello', tone: 'info' },
  );
  assert.deepEqual(
    describeRemoteEvent({ event: 'approval.request', seq: 8, command: 'rm file' }),
    { seq: 8, text: '⏸ rm file', tone: 'approval' },
  );
  assert.equal(describeRemoteEvent({ event: 'message.delta', seq: 9, delta: '' }), null);
});

test('authenticated fetch SSE reader handles split frames and skips malformed JSON', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"event":"message.delta","seq":1,'));
      controller.enqueue(encoder.encode('"delta":"A"}\n\ndata: not-json\n\n'));
      controller.enqueue(encoder.encode('data: {"event":"run.completed","seq":2}\n\n'));
      controller.close();
    },
  });
  const frames: Array<Record<string, unknown>> = [];
  await readRemoteSse(stream, (frame) => frames.push(frame));
  assert.deepEqual(frames.map((frame) => frame.event), ['message.delta', 'run.completed']);
  assert.deepEqual(frames.map((frame) => frame.seq), [1, 2]);
});

test('answering one approval does not drop a second pending request', () => {
  const first = applyApprovalFrame([], {
    event: 'approval.request', approval_id: 'ap_1', command: 'rm a', choices: ['once', 'deny'],
  });
  const both = applyApprovalFrame(first, {
    event: 'approval.request', approval_id: 'ap_2', command: 'rm b', choices: ['once', 'deny'],
  });
  assert.deepEqual(both.map((item) => item.approvalId), ['ap_1', 'ap_2']);
  const remaining = applyApprovalFrame(both, { event: 'approval.responded', approval_id: 'ap_1' });
  assert.deepEqual(remaining.map((item) => item.approvalId), ['ap_2']);
  assert.equal(remaining[0]?.command, 'rm b');
});
