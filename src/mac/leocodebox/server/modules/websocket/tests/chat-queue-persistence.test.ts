import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, chatQueueDb  } from '@/modules/database/index.js';

async function isolated(run: () => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-queue-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession('queue-session', 'claude', '/workspace/demo');
  try { await run(); }
  finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const command = (requestId: string) => ({
  sessionId: 'queue-session', userId: 1, clientRequestId: requestId,
  content: requestId, options: { model: 'fixture' }, epoch: 'old-process',
});

test('persisted pending and running commands require explicit confirmation after a process restart', async () => {
  await isolated(async () => {
    const pending = chatQueueDb.accept(command('queued')).item;
    const running = chatQueueDb.accept(command('started')).item;
    assert.equal(chatQueueDb.markRunning(running.id, 'old-run', 'old-process'), true);
    closeConnection();
    await initializeDatabase();
    chatQueueDb.recoverForEpoch('new-process');
    const restored = chatQueueDb.listPending(1, 'queue-session');
    assert.deepEqual(restored.map((item) => item.state), ['needs_confirmation', 'needs_confirmation']);
    assert.equal(restored.find((item) => item.id === running.id)?.reason, 'server_restarted_during_run');
    assert.equal(chatQueueDb.listReady('new-process').length, 0);
    assert.equal(chatQueueDb.resume(1, 'queue-session', pending.id, 'new-process'), 'resumed');
    assert.deepEqual(chatQueueDb.listReady('new-process').map((item) => item.id), [pending.id]);
  });
});

test('idempotency survives reopening the database and rejects reuse for different content', async () => {
  await isolated(async () => {
    const accepted = chatQueueDb.accept(command('request-1'));
    closeConnection();
    await initializeDatabase();
    const duplicate = chatQueueDb.accept(command('request-1'));
    assert.equal(duplicate.item.id, accepted.item.id);
    assert.equal(duplicate.duplicate, true);
    assert.throws(() => chatQueueDb.accept({ ...command('request-1'), content: 'changed' }), /REQUEST_ID_CONFLICT/);
  });
});

test('queue cancellation is scoped to user and session and cannot cancel a running item', async () => {
  await isolated(() => {
    const item = chatQueueDb.accept(command('owner-only')).item;
    assert.equal(chatQueueDb.cancel(2, 'queue-session', item.id), 'not_found');
    assert.equal(chatQueueDb.cancel(1, 'other-session', item.id), 'not_found');
    assert.equal(chatQueueDb.markRunning(item.id, 'run-1', 'old-process'), true);
    assert.equal(chatQueueDb.cancel(1, 'queue-session', item.id), 'already_started');
    assert.equal(chatQueueDb.get(item.id)?.state, 'running');
  });
});

test('legacy sequence reservations remain monotonic across process restarts', async () => {
  await isolated(async () => {
    const first = chatQueueDb.reserveSequenceRange('queue-session', 4096);
    assert.deepEqual(first, { start: 0, end: 4096 });
    closeConnection();
    await initializeDatabase();
    const second = chatQueueDb.reserveSequenceRange('queue-session', 4096);
    assert.equal(second.start, first.end);
    assert.equal(second.end, 8192);
  });
});
