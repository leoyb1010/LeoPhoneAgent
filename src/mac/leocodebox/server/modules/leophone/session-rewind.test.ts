import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HarnessJournal } from './harness-journal.js';
import { lastPromptSeq, rewindPiLastUser } from './session-rewind.js';

test('lastPromptSeq 只认 prompt，不认 steer', () => {
  const found = lastPromptSeq([
    { event: 'user.message', seq: 2, mode: 'prompt', text: '先改这里' },
    { event: 'user.message', seq: 5, mode: 'steer', text: '插一句' },
    { event: 'user.message', seq: 8, mode: 'prompt', text: '再改一处' },
  ]);
  assert.equal(found.seq, 8);
  assert.equal(found.prompt, '再改一处');
});

test('rewindPiLastUser 丢掉最后一句用户和后面的回复', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-rewind-'));
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, [
    '{"type":"session","id":"hs_a","cwd":"/tmp/a","timestamp":"2026-09-21T00:00:00.000Z"}',
    '{"type":"message","message":{"role":"user"},"id":"u1"}',
    '{"type":"message","message":{"role":"assistant"},"id":"a1"}',
    '{"type":"message","message":{"role":"user"},"id":"u2"}',
    '{"type":"message","message":{"role":"assistant"},"id":"a2"}',
    '',
  ].join('\n'));
  assert.equal(rewindPiLastUser(file), true);
  const kept = await readFile(file, 'utf8');
  assert.match(kept, /"u1"/);
  assert.doesNotMatch(kept, /"u2"/);
  assert.doesNotMatch(kept, /"a2"/);
  await rm(dir, { recursive: true, force: true });
});

test('journal rewindBefore 截在上一句 prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'journal-rewind-'));
  const log = path.join(dir, 'hs.ndjson');
  const journal = new HarnessJournal(log);
  journal.enqueue({ event: 'session.created', seq: 1 }, true);
  journal.enqueue({ event: 'user.message', seq: 2, mode: 'prompt', text: '先改这里' }, true);
  journal.enqueue({ event: 'run.completed', seq: 3 }, true);
  journal.enqueue({ event: 'user.message', seq: 4, mode: 'prompt', text: '再改一处' }, true);
  journal.enqueue({ event: 'run.completed', seq: 5 }, true);
  await journal.flush();
  const cut = lastPromptSeq((await journal.readPage(0, { limit: 20 })).events);
  assert.equal(cut.seq, 4);
  const { kept } = await journal.rewindBefore(cut.seq);
  assert.equal(kept, 3);
  const page = await journal.readPage(0, { limit: 20 });
  assert.equal(page.events.some((ev) => ev.seq === 4), false);
  assert.equal(page.events.some((ev) => ev.seq === 2), true);
  await journal.close();
  await rm(dir, { recursive: true, force: true });
});
