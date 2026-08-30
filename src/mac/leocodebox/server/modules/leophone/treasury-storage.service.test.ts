import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  treasuryDb,
} from '@/modules/database/index.js';

import {
  clearTreasuryCache,
  getTreasuryStorageUsage,
  UnsafeTreasuryStoragePathError,
} from './treasury-storage.service.js';

let root = '';
let previousDatabasePath: string | undefined;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'treasury-storage-test-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(root, { recursive: true, force: true });
});

test('Mac Treasury storage cleanup preserves originals and separates body and attachment caches', async () => {
  const originals = path.join(root, 'treasury', 'files');
  const attachments = path.join(root, 'treasury-assets');
  await mkdir(originals, { recursive: true });
  await mkdir(attachments, { recursive: true });
  const original = path.join(originals, 'original.pdf');
  const attachment = path.join(attachments, 'cached.bin');
  const body = '手机正文缓存';
  await writeFile(original, Buffer.alloc(31, 1));
  await writeFile(attachment, Buffer.alloc(17, 2));
  treasuryDb.putRemoteAsset({
    scope: 'relay:storage', item_id: 'body-item', asset_kind: 'body', content_text: body,
    file_path: null, digest: createHash('sha256').update(body).digest('hex'),
    byte_count: Buffer.byteLength(body), mime_type: 'text/plain', updated_at: 1,
  });
  treasuryDb.putRemoteAsset({
    scope: 'relay:storage', item_id: 'attachment-item', asset_kind: 'attachment', content_text: null,
    file_path: attachment, digest: createHash('sha256').update(Buffer.alloc(17, 2)).digest('hex'),
    byte_count: 17, mime_type: 'application/octet-stream', updated_at: 1,
  });

  const usage = await getTreasuryStorageUsage();
  assert.equal(usage.original_bytes, 31);
  assert.equal(usage.body_cache_bytes, Buffer.byteLength(body));
  assert.equal(usage.attachment_cache_bytes, 17);
  assert.equal(usage.attachment_cache_entries, 1);

  const bodyResult = await clearTreasuryCache('body');
  assert.equal(bodyResult.removed_entries, 1);
  assert.equal(treasuryDb.remoteAsset('relay:storage', 'body-item', 'body'), null);
  assert.equal((await getTreasuryStorageUsage()).original_bytes, 31);
  assert.equal((await getTreasuryStorageUsage()).attachment_cache_bytes, 17);

  const attachmentResult = await clearTreasuryCache('attachment');
  assert.equal(attachmentResult.removed_bytes, 17);
  assert.equal(treasuryDb.remoteAsset('relay:storage', 'attachment-item', 'attachment'), null);
  assert.equal((await getTreasuryStorageUsage()).original_bytes, 31);
  assert.equal((await getTreasuryStorageUsage()).attachment_cache_bytes, 0);
});

test('Mac Treasury attachment cleanup unlinks cache symlinks without touching their targets', async () => {
  const originals = path.join(root, 'treasury', 'files');
  const attachments = path.join(root, 'treasury-assets');
  const original = path.join(originals, 'outside-target.pdf');
  const cacheLink = path.join(attachments, 'linked-cache.bin');
  await mkdir(attachments, { recursive: true });
  await writeFile(original, Buffer.alloc(23, 3));
  await symlink(original, cacheLink);

  assert.equal((await getTreasuryStorageUsage()).attachment_cache_bytes, 0);
  await clearTreasuryCache('attachment');
  assert.equal(await readlink(cacheLink).then(() => true, () => false), false);
  assert.equal((await getTreasuryStorageUsage()).original_bytes, 54);
});

test('Mac Treasury attachment cleanup refuses a symlink cache root', async () => {
  const originals = path.join(root, 'treasury', 'files');
  const attachments = path.join(root, 'treasury-assets');
  await rm(attachments, { recursive: true, force: true });
  await symlink(originals, attachments);
  treasuryDb.putRemoteAsset({
    scope: 'relay:unsafe-storage', item_id: 'unsafe-attachment', asset_kind: 'attachment',
    content_text: null, file_path: path.join(attachments, 'original.pdf'), digest: 'a'.repeat(64),
    byte_count: 31, mime_type: 'application/pdf', updated_at: 1,
  });
  await assert.rejects(clearTreasuryCache('attachment'), UnsafeTreasuryStoragePathError);
  assert.notEqual(treasuryDb.remoteAsset('relay:unsafe-storage', 'unsafe-attachment', 'attachment'), null);
  assert.equal((await getTreasuryStorageUsage().then(() => false, (error) => (
    error instanceof UnsafeTreasuryStoragePathError
  ))), true);
  await rm(attachments, { force: true });
  assert.equal((await getTreasuryStorageUsage()).original_bytes, 54);
});
