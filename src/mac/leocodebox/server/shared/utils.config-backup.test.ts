import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backupExistingConfig, listConfigBackups, writeJsonConfig } from './utils.js';

const withBackupDir = async (fn: (ctx: { dir: string; backups: string }) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leocodebox-cfgbak-'));
  const backups = path.join(dir, 'backups');
  const prev = process.env.LEOCODEBOX_CONFIG_BACKUP_DIR;
  process.env.LEOCODEBOX_CONFIG_BACKUP_DIR = backups;
  try {
    await fn({ dir, backups });
  } finally {
    if (prev === undefined) delete process.env.LEOCODEBOX_CONFIG_BACKUP_DIR;
    else process.env.LEOCODEBOX_CONFIG_BACKUP_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
};

test('writeJsonConfig serializes with two-space indent and trailing newline', async () => {
  await withBackupDir(async ({ dir }) => {
    const file = path.join(dir, 'config.json');
    const data = { mcpServers: { demo: { type: 'stdio', command: 'x' } } };
    await writeJsonConfig(file, data);
    const raw = await readFile(file, 'utf8');
    assert.equal(raw, `${JSON.stringify(data, null, 2)}\n`);
    assert.deepEqual(JSON.parse(raw), data);
  });
});

test('overwriting an existing config backs up its prior contents', async () => {
  await withBackupDir(async ({ dir, backups }) => {
    const file = path.join(dir, 'config.json');
    await writeJsonConfig(file, { v: 1 });
    await writeJsonConfig(file, { v: 2 }); // prior ({v:1}) should be backed up
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { v: 2 });
    const bak = readdirSync(backups).filter((n) => n.endsWith('.bak'));
    assert.equal(bak.length, 1, 'exactly one rolling backup for this config');
    assert.deepEqual(JSON.parse(await readFile(path.join(backups, bak[0]), 'utf8')), { v: 1 });
  });
});

test('first write of a brand-new config creates no backup but succeeds', async () => {
  await withBackupDir(async ({ dir, backups }) => {
    const file = path.join(dir, 'fresh.json');
    await writeJsonConfig(file, { fresh: true });
    assert.equal(existsSync(file), true);
    // Nothing pre-existed, so there is nothing to back up.
    const bak = existsSync(backups) ? readdirSync(backups).filter((n) => n.endsWith('.bak')) : [];
    assert.equal(bak.length, 0);
  });
});

test('backupExistingConfig never throws when the source file is absent', async () => {
  await withBackupDir(async ({ dir }) => {
    await assert.doesNotReject(() => backupExistingConfig(path.join(dir, 'does-not-exist.json')));
  });
});

test('listConfigBackups returns [] when no backups exist and lists .bak entries otherwise', async () => {
  await withBackupDir(async ({ dir }) => {
    assert.deepEqual(await listConfigBackups(), []);
    const file = path.join(dir, 'config.json');
    await writeJsonConfig(file, { v: 1 });
    await writeJsonConfig(file, { v: 2 }); // overwrite → backs up the prior {v:1}
    const backups = await listConfigBackups();
    assert.equal(backups.length, 1);
    assert.ok(backups[0].name.endsWith('.bak'));
    // Name is a basename only — no encoded absolute path / username leakage.
    assert.equal(backups[0].name, 'config.json.bak');
    assert.equal(typeof backups[0].size, 'number');
    assert.ok(backups[0].size > 0);
    assert.ok(!Number.isNaN(Date.parse(backups[0].modifiedAt)));
  });
});
