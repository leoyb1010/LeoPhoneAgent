import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyApprovalFrame,
  describeRemoteEvent,
  isTerminalRemoteEvent,
  readRemoteSse,
} from './remoteSessionEvents';

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

test('终态帧要能被认出来 —— 否则每个任务跑完都会被当成断线重连', () => {
  for (const event of ['run.completed', 'run.failed', 'run.cancelled']) {
    assert.equal(isTerminalRemoteEvent({ event }), true);
  }
  for (const event of ['message.delta', 'tool.started', 'approval.request', '']) {
    assert.equal(isTerminalRemoteEvent({ event }), false);
  }
  assert.equal(isTerminalRemoteEvent({}), false);
});

test('正常跑完的流:最后一帧是终态,读到 done 时不该被判成异常', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"seq":1,"event":"message.delta","delta":"hi"}\n\n'));
      controller.enqueue(encoder.encode('data: {"seq":2,"event":"run.completed","output":"ok"}\n\n'));
      controller.close();
    },
  });
  let sawTerminal = false;
  await readRemoteSse(body, (frame) => {
    if (isTerminalRemoteEvent(frame)) sawTerminal = true;
  });
  // 流干净地结束 + 见过终态 = 会话结束,面板该置「已结束」并停止重连,
  // 而不是报错后每 2 秒重连一次(重连上来的会话已是终态,回放完立刻又被
  // 关流 —— 那就是一个永远停不下来的循环)。
  assert.equal(sawTerminal, true);
});
