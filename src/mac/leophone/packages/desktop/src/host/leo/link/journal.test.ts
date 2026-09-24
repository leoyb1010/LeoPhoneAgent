import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HarnessJournal } from './journal.js';

// 移植自 leocodebox harness-journal.test.ts 中只依赖日志本身的用例。

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'leo-link-journal-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

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
    assert.equal(page.events[0]?.seq, 19_951);
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
