import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { LLMProvider } from '@/shared/types.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
}

let directory: string;
let previousDatabasePath: string | undefined;
test.beforeEach(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  directory = await mkdtemp(path.join(tmpdir(), 'chat-abort-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession('app-session-early-abort', 'codex', '/workspace/demo');
});
test.afterEach(async () => {
  chatRunRegistry.clearAll();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

test('chat.abort uses the app session id before a provider session id exists', async () => {
  chatRunRegistry.clearAll();
  const socket = new FakeSocket();
  const abortedIds: string[] = [];
  const provider: LLMProvider = 'codex';

  const run = chatRunRegistry.startRun({
    appSessionId: 'app-session-early-abort',
    provider,
    providerSessionId: null,
    connection: socket as never,
    userId: 1,
  });
  assert.ok(run);

  const abort = async (id: string) => {
    abortedIds.push(id);
    return true;
  };
  const abortFns = { claude: abort, cursor: abort, codex: abort, opencode: abort, grok: abort };
  const spawn = async () => undefined;

  handleChatConnection(socket as never, { user: { id: 1 } } as never, {
    spawnFns: { claude: spawn, cursor: spawn, codex: spawn, opencode: spawn, grok: spawn },
    abortFns,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  });

  socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'app-session-early-abort' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(abortedIds, ['app-session-early-abort']);
  assert.equal(run.abortController.signal.aborted, true);
  assert.equal(chatRunRegistry.isProcessing('app-session-early-abort'), false);
  assert.ok(socket.sent.some((message) => (
    typeof message === 'object'
      && message !== null
      && (message as { kind?: string }).kind === 'complete'
  )));
  chatRunRegistry.clearAll();
});

test('ping is answered with pong so the renderer can detect half-open sockets', async () => {
  chatRunRegistry.clearAll();
  const socket = new FakeSocket();
  const spawn = async () => undefined;
  const abort = async () => true;
  handleChatConnection(socket as never, { user: { id: 1 } } as never, {
    spawnFns: { claude: spawn, cursor: spawn, codex: spawn, opencode: spawn, grok: spawn },
    abortFns: { claude: abort, cursor: abort, codex: abort, opencode: abort, grok: abort },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  });

  socket.emit('message', JSON.stringify({ type: 'ping' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const kinds = socket.sent.map((message) => (message as { kind?: string }).kind);
  assert.deepEqual(kinds, ['pong']);
});
