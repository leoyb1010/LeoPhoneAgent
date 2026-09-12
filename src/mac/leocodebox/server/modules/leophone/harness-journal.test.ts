import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HarnessJournal } from './harness-journal.js';
import { HarnessSession, setHarnessEventSink } from './harness-session.service.js';
import { buildReceipt } from './harness-digest.service.js';
import type { HarnessSpec } from './harness-specs.js';

const spec: HarnessSpec = { key: 'claude', displayName: 'fixture', executable: '', args: [], dialect: 'claude_stream_json' };
const waitTick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-journal-'));
  try { await run(directory); }
  finally { setHarnessEventSink(null); await rm(directory, { recursive: true, force: true }); }
}

test('a failed log append never publishes a critical event as durable and does not throw into the stdout pump', async () => {
  await temporary(async (directory) => {
    const blocker = path.join(directory, 'not-a-directory');
    await writeFile(blocker, 'fixture');
    const pushed: unknown[] = [];
    setHarnessEventSink((event) => pushed.push(event));
    const session = new HarnessSession({ sessionId: 'hs_io_failure', spec, cwd: directory, logPath: path.join(blocker, 'events.ndjson') });
    assert.doesNotThrow(() => session.emit({ event: 'approval.request', request_id: 'a1', command: 'fixture', choices: ['once', 'deny'] }));
    assert.equal(pushed.length, 0);
    const state = await session.flushJournal(50);
    assert.equal(state.state, 'degraded');
    assert.equal(state.durable_seq, 0);
    assert.equal(session.pendingApprovals.size, 1);
    await session.closeJournal(10);
  });
});

test('critical push is held until commit while live output keeps its original seq and timestamp', async () => {
  await temporary(async (directory) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const pushed: Record<string, unknown>[] = [];
    setHarnessEventSink((event) => pushed.push(event));
    const session = new HarnessSession({ sessionId: 'hs_commit', spec, cwd: directory, logPath: path.join(directory, 'events.ndjson'),
      journalOptions: { beforeWrite: () => hold } });
    const stream = session.subscribe(0);
    const first = stream.next();
    await waitTick();
    session.emit({ event: 'approval.request', request_id: 'a2', command: 'fixture', choices: ['once', 'deny'] });
    const live = await first;
    assert.equal(live.value?.durability, 'pending');
    assert.equal(pushed.length, 0);
    release();
    const state = await session.flushJournal();
    assert.equal(state.state, 'durable');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].durability, 'durable');
    assert.equal(pushed[0].seq, live.value?.seq);
    assert.equal(pushed[0].timestamp, live.value?.timestamp);
    await stream.return(undefined);
    await session.closeJournal();
  });
});

test('stderr flood is bounded and reserves space for a terminal event', async () => {
  await temporary(async (directory) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const journal = new HarnessJournal(path.join(directory, 'events.ndjson'), {
      maxPendingBytes: 4096, reservedCriticalBytes: 1024, maxPendingEvents: 20, beforeWrite: () => hold,
    });
    for (let seq = 1; seq <= 40; seq++) journal.enqueue({ event: 'harness.stderr', seq, text: 'x'.repeat(450) }, false);
    assert.equal(journal.enqueue({ event: 'run.completed', seq: 41, output: 'done' }, true), 'pending');
    assert.ok(journal.health().pending_bytes <= 4096);
    assert.ok(journal.health().dropped_events > 0);
    release();
    await journal.flush();
    const page = await journal.readPage(0, { limit: 100 });
    assert.ok(page.events.some((event) => event.event === 'run.completed' && event.seq === 41));
    assert.equal(journal.health().state, 'degraded');
    assert.ok(journal.health().missing_ranges.length > 0);
    await journal.close();
  });
});

test('warm indexed replay reads a bounded tail page instead of the whole long transcript', async () => {
  await temporary(async (directory) => {
    const logPath = path.join(directory, 'events.ndjson');
    const lines = Array.from({ length: 20_000 }, (_, index) => JSON.stringify({ event: 'message.delta', seq: index + 1, delta: 'x'.repeat(400) }));
    const content = lines.join('\n') + '\n';
    await writeFile(logPath, content);
    const journal = new HarnessJournal(logPath);
    await journal.initialize();
    const page = await journal.readPage(19_950, { limit: 25 });
    assert.equal(page.events.length, 25);
    assert.equal(page.events[0].seq, 19_951);
    assert.equal(page.next_after, 19_975);
    assert.equal(page.has_more, true);
    assert.ok(page.bytes_read < Buffer.byteLength(content) / 4);
    await journal.close();
  });
});

test('a corrupt middle record is reported as a gap instead of claiming complete durable history', async () => {
  await temporary(async (directory) => {
    const logPath = path.join(directory, 'events.ndjson');
    await writeFile(logPath, '{"event":"message.delta","seq":1,"delta":"a"}\ninvalid\n{"event":"message.delta","seq":3,"delta":"c"}\n');
    const journal = new HarnessJournal(logPath);
    await journal.initialize();
    assert.equal(journal.health().state, 'degraded');
    assert.ok(journal.health().missing_ranges.some((gap) => gap.from === 2 && gap.to === 2));
    assert.equal(journal.health().durable_seq, 1);
    const page = await journal.readPage(0);
    assert.deepEqual(page.events.map((event) => event.seq), [1, 3]);
    await journal.close();
  });
});

test('receipt is not issued while a terminal event cannot be saved', async () => {
  await temporary(async (directory) => {
    const blocker = path.join(directory, 'blocked');
    await writeFile(blocker, 'fixture');
    const session = new HarnessSession({ sessionId: 'hs_no_receipt', spec, cwd: directory, logPath: path.join(blocker, 'events.ndjson') });
    session.status = 'completed';
    session.emit({ event: 'run.completed', output: 'done' });
    await assert.rejects(buildReceipt(session), /JOURNAL_NOT_DURABLE/);
    await session.closeJournal(10);
  });
});

test('duplicate records are not replayed twice and cannot yield a complete durable receipt', async () => {
  await temporary(async (directory) => {
    const logPath = path.join(directory, 'events.ndjson');
    await writeFile(logPath, [
      { event: 'message.delta', seq: 1, delta: 'a' },
      { event: 'message.delta', seq: 1, delta: 'a' },
      { event: 'run.completed', seq: 2 },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const journal = new HarnessJournal(logPath);
    await journal.initialize();
    assert.equal(journal.health().state, 'degraded');
    assert.deepEqual((await journal.readPage()).events.map((event) => event.seq), [1, 2]);
    await journal.close();
  });
});

test('a terminal event buffered before subscription is delivered with its final persistence state', async () => {
  await temporary(async (directory) => {
    const session = new HarnessSession({ sessionId: 'hs_terminal', spec, cwd: directory, logPath: path.join(directory, 'events.ndjson') });
    session.status = 'completed';
    session.emit({ event: 'run.completed', output: 'done' });
    const received = [];
    for await (const event of session.subscribe(0, { journalStatus: true })) received.push(event);
    assert.equal(received.filter((event) => event.event === 'run.completed').length, 1);
    const last = received.at(-1)!;
    assert.equal(last.type, 'durability');
    assert.equal(last.state, 'durable');
    assert.equal(last.seq, undefined);
    await session.closeJournal();
  });
});

test('disconnect aborts an idle subscriber without waiting for another CLI event', async () => {
  await temporary(async (directory) => {
    const session = new HarnessSession({ sessionId: 'hs_abort', spec, cwd: directory, logPath: path.join(directory, 'events.ndjson') });
    const abort = new AbortController();
    const stream = session.subscribe(0, { signal: abort.signal });
    const next = stream.next();
    await waitTick();
    abort.abort();
    const outcome = await next;
    assert.equal(outcome.done, true);
    await session.closeJournal();
  });
});
