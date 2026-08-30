import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  isSafeTreasuryRef,
  normalizeTreasuryUrl,
  treasuryDb,
  type TreasureItem,
} from '@/modules/database/repositories/treasury.db.js';
import { treasuryService } from '@/modules/leophone/treasury.service.js';

const fixture = (overrides: Partial<TreasureItem> = {}): TreasureItem => {
  const now = '2026-08-30T00:00:00.000Z';
  return {
    id: 'fixture', schema_version: 1, kind: 'link', title: 'Fold8 SQLite 资料',
    source_uri: 'https://example.com/read?utm_source=share&b=2&a=1#part',
    source_app: 'test', source_label: '网页', original_text: '离线正文与迁移恢复',
    body_ref: 'bodies/fixture.md', preview_ref: null, mime_type: 'text/html',
    byte_count: 42, content_digest: null, summary: 'Room 和 SQLite', annotation: '检查折叠切换',
    tags: ['Android', ' android ', '离线'], collection_ids: [], pinned: false,
    archived: false, reading_state: 'reading', reading_progress: 0.5,
    created_at: now, updated_at: now, last_opened_at: null, processing_state: 'queued',
    processing_error_code: null, sync_state: 'local', origin_device_id: 'mac-test',
    deleted_at: null, ...overrides,
  };
};

async function withDatabase(run: (userId: number) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'treasury-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const result = getConnection().prepare(
    "INSERT INTO users(username,password_hash) VALUES('treasury-test','none')",
  ).run();
  try {
    await run(Number(result.lastInsertRowid));
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('treasury database persists, deduplicates, indexes, queues and tombstones', async () => {
  await withDatabase((userId) => {
    const saved = treasuryDb.save(userId, fixture());
    assert.equal(saved.deduplicated, false);
    assert.deepEqual(saved.item.tags, ['Android', '离线']);
    assert.equal(treasuryDb.readyJobs().length, 2);
    assert.equal(treasuryDb.changes().length, 1);

    const duplicate = treasuryDb.save(userId, fixture({ id: 'duplicate', source_uri: 'https://EXAMPLE.com/read?a=1&b=2' }));
    assert.equal(duplicate.deduplicated, true);
    assert.equal(treasuryDb.list(userId).length, 1);

    const otherUser = getConnection().prepare(
      "INSERT INTO users(username,password_hash) VALUES('treasury-other','none')",
    ).run();
    const otherUserId = Number(otherUser.lastInsertRowid);
    treasuryDb.save(otherUserId, fixture({
      id: 'other-user-item', source_uri: 'https://other.example/read',
    }));
    assert.equal(treasuryDb.list(userId).length, 1);
    assert.equal(treasuryDb.search(userId, 'Fold8').length, 1);
    assert.equal(treasuryDb.list(otherUserId).length, 1);

    const results = treasuryDb.search(userId, 'SQLite');
    assert.equal(results[0]?.id, 'fixture');
    const compact = treasuryService.search(userId, 'SQLite');
    assert.equal(compact[0]?.source, fixture().source_uri);
    assert.ok(compact[0]?.snippet.includes('SQLite'));
    assert.ok(compact[0]?.match_sources.includes('title'));

    assert.equal(treasuryDb.tombstone(userId, ['fixture']), 1);
    assert.equal(treasuryDb.list(userId).length, 0);
    assert.equal(treasuryDb.get(userId, ['fixture'], true)[0]?.deleted_at !== null, true);
    assert.equal(treasuryDb.changes().at(-1)?.operation, 'delete');
  });
});

test('treasury JSON and browser HTML import round trip without duplicate URLs', async () => {
  await withDatabase((userId) => {
    treasuryDb.save(userId, fixture({ kind: 'text', source_uri: null, id: 'text' }));
    const payload = treasuryDb.exportJson(userId);
    assert.match(payload, /"schema_version": 1/);
    assert.match(treasuryDb.exportMarkdown(userId), /离线正文与迁移恢复/);

    const imported = treasuryDb.importJson(userId, payload);
    assert.equal(imported, 0);
    const mixedPayload = JSON.stringify([
      fixture({ id: 'valid-import', kind: 'text', source_uri: null, title: '有效导入' }),
      { id: 'bad-import', kind: 'executable' },
    ]);
    assert.equal(treasuryDb.importJson(userId, mixedPayload), 1);
    assert.equal(treasuryDb.get(userId, ['valid-import']).length, 1);
    const bookmarks = treasuryDb.importBrowserBookmarksHtml(
      userId,
      '<DT><A HREF="https://example.com/docs">文档入口</A>',
      'mac-test',
    );
    assert.equal(bookmarks, 1);

    const markdown = [
      '## Markdown 备注',
      '',
      'Room 与 SQLite 正文',
      '',
      'Tags: #迁移 #离线',
    ].join('\n');
    assert.equal(treasuryDb.importMarkdown(userId, markdown, 'mac-test'), 1);
    const importedMarkdown = treasuryDb.search(userId, 'Markdown')[0];
    assert.equal(importedMarkdown?.original_text, 'Room 与 SQLite 正文');
    assert.deepEqual(importedMarkdown?.tags, ['迁移', '离线']);
  });
});

test('treasury URL and local reference validation reject unsafe values', () => {
  assert.equal(
    normalizeTreasuryUrl('https://EXAMPLE.com:443/read?b=2&utm_source=x&a=1#part'),
    'https://example.com/read?a=1&b=2',
  );
  assert.equal(normalizeTreasuryUrl('file:///tmp/private'), null);
  assert.equal(normalizeTreasuryUrl('https://token@example.com/private'), null);
  assert.equal(isSafeTreasuryRef('bodies/item.md'), true);
  assert.equal(isSafeTreasuryRef('../private'), false);
  assert.equal(isSafeTreasuryRef('/Users/person/private'), false);
  assert.equal(isSafeTreasuryRef('C:\\private\\secret'), false);
  assert.equal(isSafeTreasuryRef('notes/item\0.md'), false);
});

test('treasury validation rejects unsafe sources and malformed digests', async () => {
  await withDatabase((userId) => {
    assert.throws(() => treasuryDb.save(userId, fixture({ source_uri: 'file:///tmp/private' })),
      /Invalid source_uri/);
    assert.throws(() => treasuryDb.save(userId, fixture({
      id: 'bad-digest', source_uri: null, kind: 'document', content_digest: 'short',
    })), /Invalid content_digest/);
  });
});

test('shared cross-platform treasury fixture matches the Mac contract', async () => {
  const fixturePath = path.resolve('../../shared/treasury/treasure_item_v1.fixture.json');
  const decoded = JSON.parse(await readFile(fixturePath, 'utf8')) as TreasureItem;
  const roundTrip = JSON.parse(JSON.stringify(decoded)) as TreasureItem;

  assert.deepEqual(roundTrip, decoded);
  assert.equal(decoded.id, 'shared-contract-fixture');
  assert.equal(decoded.kind, 'document');
  assert.equal(decoded.reading_progress, 0.5);
});

test('treasury export is not silently truncated and update cannot tombstone', async () => {
  await withDatabase((userId) => {
    for (let index = 0; index < 501; index += 1) {
      treasuryDb.save(userId, fixture({
        id: `bulk-${index}`,
        kind: 'text',
        source_uri: null,
        title: `Bulk ${index}`,
        original_text: `row-${index}`,
      }));
    }
    const exported = JSON.parse(treasuryDb.exportJson(userId)) as TreasureItem[];
    assert.equal(exported.length, 501);

    const attemptedDelete = treasuryDb.update(userId, { ...exported[0], deleted_at: new Date().toISOString() });
    assert.equal(attemptedDelete?.deleted_at, null);
    assert.equal(treasuryDb.get(userId, [exported[0].id]).length, 1);
  });
});

test('treasury 1000-row list and keyword search stay bounded', async () => {
  await withDatabase((userId) => {
    for (let index = 0; index < 1_000; index += 1) {
      treasuryDb.save(userId, fixture({
        id: `perf-${index}`,
        kind: 'text',
        source_uri: null,
        title: `Performance ${index}`,
        original_text: index === 999 ? 'uniqueperformancehit' : `ordinary-${index}`,
      }));
    }

    const listStarted = performance.now();
    assert.equal(treasuryDb.list(userId, 100).length, 100);
    const listMs = performance.now() - listStarted;
    const searchStarted = performance.now();
    assert.equal(treasuryDb.search(userId, 'uniqueperformancehit')[0]?.id, 'perf-999');
    const searchMs = performance.now() - searchStarted;

    assert.ok(listMs < 400, `1000-row first page took ${listMs.toFixed(1)}ms`);
    assert.ok(searchMs < 150, `1000-row search took ${searchMs.toFixed(1)}ms`);
  });
});
