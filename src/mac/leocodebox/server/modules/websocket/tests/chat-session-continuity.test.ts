import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

type Frame = Record<string, any>;
class Socket extends EventEmitter {
  readyState = 1;
  frames: Frame[] = [];
  send(value: string) { this.frames.push(JSON.parse(value)); }
  receive(value: Frame) { this.emit('message', JSON.stringify(value)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const settle = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

async function isolated(runTest: () => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-continuity-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();
  sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
  try { await runTest(); }
  finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function runtime() {
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const prompts: string[] = [];
  const pending = [{ requestId: 'approval-1', toolName: 'Bash', input: { command: 'fixture' } }];
  const decisions: unknown[] = [];
  const spawn = async (command: string, _options: unknown, writer: any) => {
    prompts.push(command);
    if (command === 'first') await firstDone;
    writer.send({ kind: 'text', provider: 'claude', content: command });
    writer.send({ kind: 'complete', provider: 'claude', exitCode: 0 });
  };
  const abort = async () => true;
  const dependencies = {
    spawnFns: { claude: spawn, codex: spawn, cursor: spawn, opencode: spawn, grok: spawn },
    abortFns: { claude: abort, codex: abort, cursor: abort, opencode: abort, grok: abort },
    getPendingApprovalsForSession: () => pending,
    resolveToolApproval: (_id: string, decision: unknown) => { decisions.push(decision); pending.length = 0; },
  };
  const connect = (userId = 1) => {
    const socket = new Socket();
    handleChatConnection(socket as never, { user: { id: userId } } as never, dependencies);
    return socket;
  };
  return { connect, prompts, releaseFirst, decisions };
}
const send = (socket: Socket, content: string, clientRequestId = content) =>
  socket.receive({ type: 'chat.send', sessionId: 'session-a', content, clientRequestId });
const subscribe = (socket: Socket) =>
  socket.receive({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a', lastSeq: 0 }] });

test('legacy lastSeq continues across turns while each turn has a distinct run identity', async () => {
  await isolated(async () => {
    const socket = new Socket();
    const input = { appSessionId: 'session-a', provider: 'claude' as const, providerSessionId: null, connection: socket, userId: 1 };
    const first = chatRunRegistry.startRun(input)!;
    for (let i = 0; i < 20; i++) first.writer.send({ kind: 'stream_delta', content: String(i) });
    first.writer.send({ kind: 'complete', exitCode: 0 });
    const lastSeq = first.lastSeq;
    const second = chatRunRegistry.startRun(input)!;
    second.writer.send({ kind: 'stream_delta', content: 'second turn' });
    assert.deepEqual(chatRunRegistry.replayEvents('session-a', lastSeq).map((event) => event.content), ['second turn']);
    assert.equal(typeof (first as any).runId, 'string');
    assert.notEqual((first as any).runId, (second as any).runId);
    assert.ok(second.lastSeq > lastSeq);
  });
});

test('subscribing from a second observer does not steal the first observer stream', async () => {
  await isolated(async () => {
    const first = new Socket();
    const second = new Socket();
    const run = chatRunRegistry.startRun({ appSessionId: 'session-a', provider: 'claude', providerSessionId: null, connection: first, userId: 1 })!;
    chatRunRegistry.attachConnection('session-a', second);
    run.writer.send({ kind: 'stream_delta', content: 'shared' });
    assert.deepEqual(first.frames.map((frame) => frame.content), ['shared']);
    assert.deepEqual(second.frames.map((frame) => frame.content), ['shared']);
  });
});

test('a queued command uses current observers after its original socket closes', async () => {
  await isolated(async () => {
    const harness = runtime();
    const original = harness.connect();
    try {
      send(original, 'first');
      send(original, 'second');
      send(original, 'third');
      await settle();
      original.close();
      const replacement = harness.connect();
      subscribe(replacement);
      await settle();
      harness.releaseFirst();
      await settle();
      assert.deepEqual(harness.prompts, ['first', 'second', 'third']);
      assert.ok(replacement.frames.some((frame) => frame.kind === 'text' && frame.content === 'second'));
    } finally { harness.releaseFirst(); await settle(); }
  });
});

test('accepted clientRequestId is idempotent, including after the run finishes', async () => {
  await isolated(async () => {
    const harness = runtime();
    const socket = harness.connect();
    send(socket, 'once', 'same-request');
    await settle();
    send(socket, 'once', 'same-request');
    await settle();
    assert.deepEqual(harness.prompts, ['once']);
    assert.ok(socket.frames.some((frame) => frame.kind === 'chat_send_ack' && frame.duplicate === true));
  });
});

test('queue is visible after resubscribe and cancelling one item does not stop the active run', async () => {
  await isolated(async () => {
    const harness = runtime();
    const socket = harness.connect();
    try {
      send(socket, 'first');
      send(socket, 'cancel me');
      await settle();
      subscribe(socket);
      await settle();
      const ack = socket.frames.filter((frame) => frame.kind === 'chat_subscribed').at(-1)!;
      assert.equal(ack.queueItems?.length, 1);
      assert.equal(ack.queueItems[0].content, 'cancel me');
      socket.receive({ type: 'chat.queue.cancel', sessionId: 'session-a', queueItemId: ack.queueItems[0].id });
      await settle();
      assert.equal(chatRunRegistry.isProcessing('session-a'), true);
      harness.releaseFirst();
      await settle();
      assert.deepEqual(harness.prompts, ['first']);
    } finally { harness.releaseFirst(); await settle(); }
  });
});

test('queue capacity rejects overflow instead of accepting unbounded commands', async () => {
  await isolated(async () => {
    const harness = runtime();
    const socket = harness.connect();
    try {
      send(socket, 'first');
      for (let i = 0; i < 40; i++) send(socket, `queued-${i}`);
      await settle();
      assert.ok(socket.frames.some((frame) => frame.code === 'QUEUE_FULL'));
      subscribe(socket);
      await settle();
      const ack = socket.frames.filter((frame) => frame.kind === 'chat_subscribed').at(-1)!;
      assert.ok(ack.queueItems.length <= 16);
    } finally { harness.releaseFirst(); await settle(); }
  });
});

test('simultaneous approval answers consume one request and notify both observers', async () => {
  await isolated(async () => {
    const harness = runtime();
    const first = harness.connect();
    const second = harness.connect();
    try {
      send(first, 'first');
      subscribe(second);
      await settle();
      first.receive({ type: 'chat.permission-response', sessionId: 'session-a', requestId: 'approval-1', allow: true });
      second.receive({ type: 'chat.permission-response', sessionId: 'session-a', requestId: 'approval-1', allow: false });
      await settle();
      assert.equal(harness.decisions.length, 1);
      assert.ok(first.frames.some((frame) => frame.kind === 'permission_resolved' && frame.requestId === 'approval-1'));
      assert.ok(second.frames.some((frame) => frame.kind === 'permission_resolved' && frame.requestId === 'approval-1'));
      assert.ok(second.frames.some((frame) => frame.kind === 'chat_permission_ack' && frame.status === 'already_resolved'));
    } finally { harness.releaseFirst(); await settle(); }
  });
});

test('another authenticated user cannot see or cancel another user queue or receive their live output', async () => {
  await isolated(async () => {
    const harness = runtime();
    const owner = harness.connect(1);
    const other = harness.connect(2);
    try {
      send(owner, 'first');
      send(owner, 'private queue');
      await settle();
      subscribe(owner);
      subscribe(other);
      await settle();
      const ownerAck = owner.frames.filter((frame) => frame.kind === 'chat_subscribed').at(-1)!;
      const id = ownerAck.queueItems?.[0]?.id;
      assert.ok(id);
      other.receive({ type: 'chat.queue.cancel', sessionId: 'session-a', queueItemId: id });
      await settle();
      const otherAck = other.frames.filter((frame) => frame.kind === 'chat_subscribed').at(-1);
      assert.equal(otherAck?.queueItems?.length ?? 0, 0);
      harness.releaseFirst();
      await settle();
      assert.deepEqual(harness.prompts, ['first', 'private queue']);
      assert.equal(other.frames.some((frame) => frame.kind === 'text'), false);
    } finally { harness.releaseFirst(); await settle(); }
  });
});


test('a failed durable running-state transition never creates a phantom active run', async () => {
  await isolated(async () => {
    const harness = runtime();
    const socket = harness.connect();
    getConnection().exec(`CREATE TRIGGER fail_chat_claim BEFORE UPDATE OF state ON chat_queue_items
      WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END;`);
    send(socket, 'cannot start');
    await settle();
    assert.deepEqual(harness.prompts, []);
    assert.equal(chatRunRegistry.isProcessing('session-a'), false);
    assert.ok(socket.frames.some((frame) => frame.kind === 'protocol_error' && frame.code === 'QUEUE_STORAGE_FAILED'));
  });
});
