import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RemoteTreasureMetadata } from '../database/repositories/treasury.db.js';

import {
  cachedAttachmentPath,
  cachedAttachmentPartialPath,
  offlineBodyCandidates,
  offlineCollectionCandidates,
  isCachedAttachmentPath,
  isAllowedTreasuryAssetMime,
  isValidCachedBody,
  publicTreasuryError,
  resumableTreasuryPartialSize,
  safeAssetHeaders,
  validTreasuryContentRange,
} from './fleet.routes.js';

test('fleet treasury asset headers require bounded digest count and safe mime', () => {
  const response = new Response('body', { headers: {
    'x-treasury-digest': 'a'.repeat(64),
    'x-treasury-byte-count': '4',
    'content-type': 'text/plain; charset=utf-8',
  } });
  assert.deepEqual(safeAssetHeaders(response, 10), {
    digest: 'a'.repeat(64), byteCount: 4, mimeType: 'text/plain',
  });
  assert.throws(() => safeAssetHeaders(new Response('', { headers: {
    'x-treasury-digest': 'not-a-digest', 'x-treasury-byte-count': '999',
    'content-type': 'text/plain',
  } }), 10), /invalid treasury asset metadata/);
  assert.equal(isAllowedTreasuryAssetMime('application/pdf'), true);
  assert.equal(isAllowedTreasuryAssetMime('application/x-executable'), false);
  assert.throws(() => safeAssetHeaders(new Response('', { headers: {
    'x-treasury-digest': 'a'.repeat(64), 'x-treasury-byte-count': '4',
    'content-type': 'application/x-executable',
  } }), 10), /invalid treasury asset metadata/);
});

test('fleet treasury errors never expose machine-local paths or tokens', () => {
  const hostile = new Error('/Users/private/Library/secret Relay-Key=do-not-return');
  assert.equal(publicTreasuryError(hostile, '远端附件读取失败'), '远端附件读取失败');
  assert.equal(publicTreasuryError(hostile, '远端附件读取失败').includes(hostile.message), false);
});

test('fleet treasury cached body is revalidated before offline reuse', () => {
  const text = '离线缓存正文';
  const digest = createHash('sha256').update(Buffer.from(text)).digest('hex');
  assert.equal(isValidCachedBody({
    content_text: text, digest, byte_count: Buffer.byteLength(text), mime_type: 'text/plain',
  }), true);
  assert.equal(isValidCachedBody({
    content_text: `${text}损坏`, digest, byte_count: Buffer.byteLength(text), mime_type: 'text/plain',
  }), false);
});

test('fleet treasury attachment cache path is digest-derived and contained', () => {
  const cached = cachedAttachmentPath('relay:test', '../../item', 'b'.repeat(64));
  const partial = cachedAttachmentPartialPath('relay:test', '../../item');
  assert.equal(isCachedAttachmentPath(cached), true);
  assert.equal(isCachedAttachmentPath(partial), true);
  assert.equal(path.basename(cached).length, 68);
  assert.match(path.basename(partial), /^\.[0-9a-f]{64}\.partial$/);
  assert.equal(isCachedAttachmentPath('/private/treasury-secret.bin'), false);
});

test('fleet treasury range validation requires the requested prefix and full size', () => {
  assert.equal(validTreasuryContentRange('bytes 4-9/10', 4, 10), true);
  assert.equal(validTreasuryContentRange('bytes 3-9/10', 4, 10), false);
  assert.equal(validTreasuryContentRange('bytes 4-9/11', 4, 10), false);
  assert.equal(validTreasuryContentRange('bytes */10', 4, 10), false);
  assert.equal(validTreasuryContentRange('bytes 4-10/10', 4, 10), false);
  assert.equal(validTreasuryContentRange(null, 4, 10), false);
});

test('fleet treasury keeps valid partial bytes and rejects symbolic-link partials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treasury-range-'));
  try {
    const partial = path.join(directory, '.asset.partial');
    await fs.writeFile(partial, Buffer.from('prefix'));
    assert.equal(await resumableTreasuryPartialSize(partial), 6);

    const outside = path.join(directory, 'outside.bin');
    await fs.writeFile(outside, Buffer.from('secret'));
    await fs.rm(partial);
    await fs.symlink(outside, partial);
    assert.equal(await resumableTreasuryPartialSize(partial), 0);
    await assert.rejects(fs.lstat(partial));
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fleet treasury offline collection prefetch is explicit bounded and metadata-only', () => {
  const base = {
    kind: 'text', title: '', source_uri: '', source_app: '', source_label: '', summary: '',
    annotation: '', tags: [], collection_ids: ['work'], pinned: false, archived: false,
    reading_state: 'none', reading_progress: 0, created_at: 1, updated_at: 1,
    last_opened_at: 0, processing_state: 'ready', processing_error_code: '',
    content_digest: '', byte_count: 0, mime_type: '', body_available: true,
    attachment_available: false, origin_device_id: 'phone', deleted_at: 0,
  } satisfies Omit<RemoteTreasureMetadata, 'id'>;
  const items: RemoteTreasureMetadata[] = [
    { ...base, id: 'one' }, { ...base, id: 'two' },
    { ...base, id: 'other', collection_ids: ['other'] },
    { ...base, id: 'missing-body', body_available: false },
    { ...base, id: 'deleted', deleted_at: 2 },
  ];
  assert.deepEqual(offlineCollectionCandidates(items, 'work', 1).map((item) => item.id), ['one']);
  assert.deepEqual(offlineCollectionCandidates(items, 'work').map((item) => item.id), ['one', 'two']);
  assert.deepEqual(offlineBodyCandidates(items, null).map((item) => item.id), ['one', 'two', 'other']);
});
