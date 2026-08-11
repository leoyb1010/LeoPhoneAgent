import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applySnapshot,
  captureSnapshot,
  deleteSnapshot,
  listSnapshots,
  sanitizeSnapshotName,
} from '../login-snapshot.service.js';

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.LEOCODEBOX_TEST_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'login-snap-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  try {
    await run(home);
  } finally {
    if (prev === undefined) delete process.env.LEOCODEBOX_TEST_HOME; else process.env.LEOCODEBOX_TEST_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeClaudeCreds(home: string, content: string): Promise<void> {
  const p = path.join(home, '.claude', '.credentials.json');
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
}

test('snapshot name sanitization blocks path traversal and unsafe chars', () => {
  // No slash survives, so a name can never escape its target dir.
  assert.equal(sanitizeSnapshotName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeSnapshotName('..'), '');
  assert.equal(sanitizeSnapshotName('a/b'), 'a-b');
  assert.equal(sanitizeSnapshotName('v1.2-work'), 'v1.2-work');
  assert.equal(sanitizeSnapshotName('   '), '');
});

test('capture → list → apply restores the credential and backs up the current', async () => {
  await withHome(async (home) => {
    await writeClaudeCreds(home, '{"account":"work"}');
    await captureSnapshot('claude', 'work');

    // Log in as a different account, snapshot it too.
    await writeClaudeCreds(home, '{"account":"personal"}');
    await captureSnapshot('claude', 'personal');

    const snaps = await listSnapshots('claude');
    assert.ok(snaps.find((s) => s.name === 'work'));
    assert.ok(snaps.find((s) => s.name === 'personal'));
    // "personal" is currently live.
    assert.equal(snaps.find((s) => s.name === 'personal')?.active, true);

    // Switch back to work — current (personal) must be auto-backed-up first.
    const applied = await applySnapshot('claude', 'work');
    assert.equal(applied.applied, true);
    assert.ok(applied.backup, 'current login was backed up before overwrite');
    assert.equal(await readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'), '{"account":"work"}');
  });
});

test('capture without a login refuses; unknown target refuses', async () => {
  await withHome(async () => {
    await assert.rejects(() => captureSnapshot('claude', 'nope'), /not logged in/i);
    await assert.rejects(() => captureSnapshot('grok' as string, 'x'), /Unsupported target/i);
  });
});

test('delete removes a snapshot', async () => {
  await withHome(async (home) => {
    await writeClaudeCreds(home, '{"account":"work"}');
    await captureSnapshot('claude', 'work');
    assert.equal(await deleteSnapshot('claude', 'work'), true);
    assert.equal(await deleteSnapshot('claude', 'work'), false);
  });
});
