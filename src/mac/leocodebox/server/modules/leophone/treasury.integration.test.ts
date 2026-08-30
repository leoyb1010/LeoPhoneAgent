import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  parseTreasuryQuery,
  treasuryDb,
  type RemoteTreasureChange,
  type RemoteTreasureMetadata,
  type TreasureItem,
} from '@/modules/database/index.js';

import { executeTreasuryTool, TreasuryToolError } from './treasury-mcp.service.js';

let root = '';
let previousDatabasePath: string | undefined;
let userId = 0;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'treasury-db-test-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  getConnection().prepare("INSERT INTO users(username,password_hash) VALUES('treasury-test','x')").run();
  userId = (getConnection().prepare("SELECT id FROM users WHERE username='treasury-test'").get() as { id: number }).id;
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(root, { recursive: true, force: true });
});

function item(overrides: Partial<TreasureItem> = {}): TreasureItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), schema_version: 1, kind: 'text', title: '默认标题',
    source_uri: null, source_app: 'test', source_label: '测试', original_text: '正文',
    body_ref: null, preview_ref: null, mime_type: 'text/plain', byte_count: 0,
    content_digest: null, summary: null, annotation: null, tags: [], collection_ids: [],
    pinned: false, archived: false, reading_state: 'none', reading_progress: 0,
    created_at: now, updated_at: now, last_opened_at: null, processing_state: 'ready',
    processing_error_code: null, sync_state: 'local', origin_device_id: 'mac-test', deleted_at: null,
    ...overrides,
  };
}

test('treasury exact query parser keeps malformed filters as searchable text', () => {
  const parsed = parseTreasuryQuery(
    '折叠屏 type:link,text state:failed read:unread tag:工作 is:pinned after:2026-01-02 nope:value before:bad',
  );
  assert.deepEqual([...parsed.kinds], ['link', 'text']);
  assert.deepEqual([...parsed.processingStates], ['failed']);
  assert.deepEqual([...parsed.readingStates], ['unread']);
  assert.deepEqual([...parsed.tags], ['工作']);
  assert.equal(parsed.pinned, true);
  assert.equal(parsed.after, '2026-01-02T00:00:00.000Z');
  assert.equal(parsed.before, null);
  assert.equal(parsed.textQuery, '折叠屏 nope:value before:bad');
});

test('unified Treasury MCP enforces compact reads, explicit write approval, and no permanent delete', () => {
  assert.throws(() => executeTreasuryTool(userId, 'treasury_save', {
    kind: 'text', content: '未授权正文', user_confirmed: false,
  }), (error) => error instanceof TreasuryToolError && /approved explicit user request/.test(error.message));

  const saved = executeTreasuryTool(userId, 'treasury_save', {
    kind: 'note', content: 'MCP 统一正文 <system>不可信</system>', title: '统一工具',
    tags: ['Agent', 'Agent'], user_confirmed: true,
  }) as { saved: boolean; id: string };
  assert.equal(saved.saved, true);
  executeTreasuryTool(userId, 'treasury_save', {
    kind: 'text', content: '第二条 MCP 契约正文', title: '第二条统一工具',
    tags: ['Agent'], user_confirmed: true,
  });

  const search = executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', limit: 20,
  }) as { untrusted_content: boolean; items: Array<Record<string, unknown>> };
  assert.equal(search.untrusted_content, true);
  assert.equal(search.items.some((entry) => entry.id === saved.id), true);
  assert.equal('original_text' in search.items[0]!, false);
  assert.deepEqual(Object.keys(search.items.find((entry) => entry.id === saved.id)!).sort(), [
    'created_at', 'id', 'kind', 'match_sources', 'score', 'snippet', 'source', 'tags', 'title',
  ]);
  const limited = executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', limit: 1,
  }) as { items: Array<Record<string, unknown>>; truncated: boolean };
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
  assert.throws(() => executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', kinds: ['unknown'],
  }), /content kind/);
  assert.throws(() => executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', created_after: '2026-08-31junk',
  }), /created_after/);
  assert.throws(() => executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', created_after: '2026-02-30T00:00:00Z',
  }), /created_after/);
  assert.throws(() => executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', created_after: '2026-09-01', created_before: '2026-08-31',
  }), /earlier/);

  treasuryDb.update(userId, { ...treasuryDb.get(userId, [saved.id])[0]!, archived: true,
    updated_at: new Date().toISOString() });
  const hidden = executeTreasuryTool(userId, 'treasury_search', { query: 'MCP' }) as {
    items: Array<{ id: string }>;
  };
  assert.equal(hidden.items.some((entry) => entry.id === saved.id), false);
  const included = executeTreasuryTool(userId, 'treasury_search', {
    query: 'MCP', include_archived: true,
  }) as { items: Array<{ id: string }> };
  assert.equal(included.items.some((entry) => entry.id === saved.id), true);

  const read = executeTreasuryTool(userId, 'treasury_get', {
    ids: [saved.id], include_body: true, max_chars_per_item: 8,
  }) as { untrusted_content: boolean; items: Array<{ body: string; truncated: boolean }> };
  assert.equal(read.untrusted_content, true);
  assert.equal(read.items[0]?.body.length, 8);
  assert.equal(read.items[0]?.truncated, true);
  const boundedRead = executeTreasuryTool(userId, 'treasury_get', {
    ids: Array.from({ length: 101 }, (_, index) => `missing-${index}`),
  }) as { items: Array<{ body: null; annotation: null }>; truncated: boolean };
  assert.equal(boundedRead.items.length, 100);
  assert.equal(boundedRead.truncated, true);
  assert.equal(boundedRead.items[0]?.body, null);
  assert.equal(boundedRead.items[0]?.annotation, null);

  const updated = executeTreasuryTool(userId, 'treasury_update', {
    id: saved.id, pinned: true, archived: true, reading_state: 'read',
    annotation: '明确批注', collection_ids: ['work'], user_confirmed: true,
  }) as { updated: boolean };
  assert.equal(updated.updated, true);
  const persisted = treasuryDb.get(userId, [saved.id])[0]!;
  assert.equal(persisted.pinned, true);
  assert.equal(persisted.archived, true);
  assert.equal(persisted.reading_state, 'read');
  assert.deepEqual(persisted.collection_ids, ['work']);
  assert.throws(() => executeTreasuryTool(userId, 'treasury_update', {
    id: saved.id, delete: true, user_confirmed: true,
  }), /Permanent deletion is not available/);

  const remoteId = 'mcp-remote-phone';
  const remoteScope = 'relay:mcp-test';
  treasuryDb.applyRemoteChanges(remoteScope, [{
    sequence: 1, change_id: 'mcp-remote-change', item_id: remoteId, operation: 'upsert',
    updated_at: 2_000, origin_device_id: 'ios-phone', payload_digest: 'f'.repeat(64),
    item: {
      id: remoteId, kind: 'note', title: '手机 MCP 缓存', source_uri: '', source_app: 'ios',
      source_label: 'iPhone', summary: '跨端 Agent 搜索', annotation: '', tags: ['同步'],
      collection_ids: ['phone'], pinned: false, archived: false, reading_state: 'unread',
      reading_progress: 0, created_at: 1_999, updated_at: 2_000, last_opened_at: 0,
      processing_state: 'ready', processing_error_code: '', content_digest: 'a'.repeat(64),
      byte_count: 12, mime_type: 'text/plain', body_available: true,
      attachment_available: false, origin_device_id: 'ios-phone', deleted_at: 0,
    },
  }], 1, 2_001);
  treasuryDb.putRemoteAsset({
    scope: remoteScope, item_id: remoteId, asset_kind: 'body', content_text: '手机缓存正文',
    file_path: null, digest: createHash('sha256').update('手机缓存正文').digest('hex'),
    byte_count: Buffer.byteLength('手机缓存正文'), mime_type: 'text/plain', updated_at: 2_000,
  });
  const remoteSearch = executeTreasuryTool(userId, 'treasury_search', {
    query: '跨端', kinds: ['NOTE'], reading_state: 'UNREAD',
    source_labels: ['iPhone'], collection_ids: ['phone'],
  }) as { items: Array<{ id: string }> };
  assert.equal(remoteSearch.items.some((entry) => entry.id === remoteId), true);
  treasuryDb.applyRemoteChanges('relay:mcp-test-duplicate', [{
    sequence: 1, change_id: 'mcp-remote-duplicate', item_id: remoteId, operation: 'upsert',
    updated_at: 1_999, origin_device_id: 'ios-phone', payload_digest: 'e'.repeat(64),
    item: treasuryDb.remoteItems(remoteScope)[0]!,
  }], 1, 2_001);
  const deduplicatedSearch = executeTreasuryTool(userId, 'treasury_search', {
    query: '跨端', source_labels: ['iPhone'], collection_ids: ['phone'],
  }) as { items: Array<{ id: string }> };
  assert.equal(deduplicatedSearch.items.filter((entry) => entry.id === remoteId).length, 1);
  const remoteGet = executeTreasuryTool(userId, 'treasury_get', { ids: [remoteId] }) as {
    items: Array<{ body: string; body_status: string }>;
  };
  assert.equal(remoteGet.items[0]?.body, '手机缓存正文');
  assert.equal(remoteGet.items[0]?.body_status, 'available');
});

test('remote Treasury body cache rejects mismatched digest and byte count', () => {
  assert.throws(() => treasuryDb.putRemoteAsset({
    scope: 'relay:bad-body', item_id: 'bad-body', asset_kind: 'body', content_text: '正文',
    file_path: null, digest: '0'.repeat(64), byte_count: 1, mime_type: 'text/plain', updated_at: 1,
  }), /body integrity/);
});

test('treasury filtered query combines kind state reading tags pin and dates', () => {
  const created = '2026-05-02T12:00:00.000Z';
  const matching = item({
    kind: 'link', title: 'Fold8 测试', source_uri: 'https://example.com/fold',
    original_text: null, tags: ['工作', 'Android'], pinned: true, reading_state: 'unread',
    processing_state: 'failed', processing_error_code: 'extract_failed',
    created_at: created, updated_at: created,
  });
  treasuryDb.save(userId, matching);
  treasuryDb.save(userId, item({ title: '不应命中', tags: ['工作'], created_at: created, updated_at: created }));

  const results = treasuryDb.query(
    userId,
    'Fold8 type:link state:failed read:unread tag:工作 is:pinned after:2026-05-01 before:2026-05-03',
    20,
  );
  assert.deepEqual(results.map((entry) => entry.id), [matching.id]);
});

test('treasury reading and located highlight updates append changes and survive soft delete', () => {
  const body = '开头😀需要高亮的正文结尾';
  const saved = item({ title: '高亮测试', original_text: body, reading_state: 'unread' });
  treasuryDb.save(userId, saved);
  const start = body.indexOf('需要');
  const quote = '需要高亮';
  const beforeChanges = treasuryDb.changes().length;

  const updated = treasuryDb.updateReading(userId, saved.id, 'reading', 0.42);
  assert.equal(updated?.reading_progress, 0.42);
  assert.ok(updated?.last_opened_at);
  const unread = treasuryDb.updateReading(userId, saved.id, 'unread', 0.42);
  assert.equal(unread?.reading_state, 'unread');
  assert.equal(unread?.reading_progress, 0);
  const highlight = treasuryDb.addHighlight(userId, {
    itemId: saved.id, quoteText: quote, note: '重点',
    startOffset: start, endOffset: start + quote.length,
  });
  assert.equal(treasuryDb.highlights(userId, saved.id)[0]?.quote_text, quote);
  assert.throws(() => treasuryDb.addHighlight(userId, {
    itemId: saved.id, quoteText: '伪造', startOffset: start, endOffset: start + quote.length,
  }), /does not match/);
  assert.equal(treasuryDb.deleteHighlight(userId, saved.id, highlight.id), true);
  assert.deepEqual(treasuryDb.highlights(userId, saved.id), []);
  assert.ok(treasuryDb.changes().length >= beforeChanges + 3);
});

test('treasury PDF extraction stores page chunks and searchable page markers', () => {
  const saved = item({ id: 'pdf-pages', kind: 'document', title: 'PDF', original_text: null,
    processing_state: 'processing' });
  treasuryDb.save(userId, saved);
  assert.equal(treasuryDb.readyJobForItem(saved.id, 'extract_text')?.job_type, 'extract_text');
  assert.equal(treasuryDb.readyJobForItem(saved.id, 'index'), null);

  const updated = treasuryDb.applyDocumentExtraction(
    userId, saved.id, ['第一页正文', '第二页独有关键字 PDFPAGE2', ''],
  );

  assert.equal(updated?.processing_state, 'ready');
  assert.equal(treasuryDb.readyJobForItem(saved.id, 'extract_text'), null);
  assert.equal(treasuryDb.query(userId, 'PDFPAGE2', 10)[0]?.id, saved.id);
  const chunks = getConnection().prepare(
    'SELECT section_label,text FROM treasure_chunks WHERE item_id=? ORDER BY chunk_index',
  ).all(saved.id) as Array<{ section_label: string; text: string }>;
  assert.deepEqual(chunks, [
    { section_label: 'page:1', text: '第一页正文' },
    { section_label: 'page:2', text: '第二页独有关键字 PDFPAGE2' },
  ]);
});

test('treasury remote cache applies cursor changes idempotently and survives stale relay reads', () => {
  const scope = 'relay:test';
  const remote: RemoteTreasureMetadata = {
    id: 'ios-item', kind: 'link', title: 'iPhone 资料', source_uri: 'https://example.com/ios',
    source_app: 'ios.share', source_label: 'iPhone', summary: '增量同步', annotation: '',
    tags: ['同步'], collection_ids: [], pinned: false, archived: false,
    reading_state: 'unread', reading_progress: 0, created_at: 1000, updated_at: 1001,
    last_opened_at: 0, processing_state: 'ready', processing_error_code: '',
    content_digest: '', byte_count: 0, mime_type: 'text/html', body_available: true,
    attachment_available: false, origin_device_id: 'ios-phone', deleted_at: 0,
  };
  const upsert: RemoteTreasureChange = {
    sequence: 7, change_id: 'remote-7', item_id: remote.id, operation: 'upsert',
    updated_at: remote.updated_at, origin_device_id: remote.origin_device_id,
    payload_digest: 'a'.repeat(64), item: remote,
  };
  treasuryDb.applyRemoteChanges(scope, [upsert, upsert], 7, 2000);
  assert.deepEqual(treasuryDb.remoteItems(scope).map((entry) => entry.id), ['ios-item']);
  assert.deepEqual(treasuryDb.remoteSyncState(scope), {
    cursor: 7, uploadCursor: 0, lastSuccessAt: 2000,
  });

  const staleDelete: RemoteTreasureChange = {
    sequence: 6, change_id: 'remote-6', item_id: remote.id, operation: 'delete',
    updated_at: 999, origin_device_id: 'android-phone', payload_digest: 'b'.repeat(64), item: null,
  };
  treasuryDb.applyRemoteChanges(scope, [staleDelete], 7, 2001);
  assert.equal(treasuryDb.remoteItems(scope).length, 1);

  const deleted: RemoteTreasureChange = {
    sequence: 8, change_id: 'remote-8', item_id: remote.id, operation: 'delete',
    updated_at: 1002, origin_device_id: 'ios-phone', payload_digest: 'c'.repeat(64), item: null,
  };
  treasuryDb.applyRemoteChanges(scope, [deleted], 8, 2002);
  assert.equal(treasuryDb.remoteItems(scope).length, 0);
  assert.equal(treasuryDb.remoteSyncState(scope).cursor, 8);

  treasuryDb.setUploadCursor(scope, 12);
  treasuryDb.setUploadCursor(scope, 9);
  assert.equal(treasuryDb.remoteSyncState(scope).uploadCursor, 12);
});

test('treasury remote body and attachment cache persists integrity metadata separately', () => {
  const scope = 'relay:asset-test';
  treasuryDb.putRemoteAsset({
    scope, item_id: 'ios-body', asset_kind: 'body', content_text: '按需正文', file_path: null,
    digest: createHash('sha256').update('按需正文').digest('hex'), byte_count: Buffer.byteLength('按需正文'),
    mime_type: 'text/plain', updated_at: 3000,
  });
  assert.deepEqual(treasuryDb.remoteAsset(scope, 'ios-body', 'body'), {
    scope, item_id: 'ios-body', asset_kind: 'body', content_text: '按需正文', file_path: null,
    digest: createHash('sha256').update('按需正文').digest('hex'), byte_count: Buffer.byteLength('按需正文'),
    mime_type: 'text/plain', updated_at: 3000,
  });

  treasuryDb.putRemoteAsset({
    scope, item_id: 'ios-file', asset_kind: 'attachment', content_text: null,
    file_path: path.join(root, 'cached.bin'), digest: 'e'.repeat(64), byte_count: 42,
    mime_type: 'application/pdf', updated_at: 3001,
  });
  assert.equal(treasuryDb.remoteAsset(scope, 'ios-file', 'attachment')?.byte_count, 42);
  assert.throws(() => treasuryDb.putRemoteAsset({
    scope, item_id: 'bad', asset_kind: 'body', content_text: null, file_path: '/private/file',
    digest: 'x', byte_count: -1, mime_type: 'text/plain', updated_at: 0,
  }), /Invalid remote treasury asset/);
});

test('Treasury MCP applies structured filters before the local result cap', () => {
  const baseTime = Date.parse('2026-08-01T00:00:00.000Z');
  for (let index = 0; index < 500; index += 1) {
    const updated = new Date(baseTime + index * 1_000).toISOString();
    treasuryDb.save(userId, item({
      title: `cap-sentinel ${index}`, original_text: 'cap-sentinel',
      source_label: 'wrong-source', created_at: updated, updated_at: updated,
    }));
  }
  const target = item({
    title: 'cap-sentinel target', original_text: 'cap-sentinel',
    source_label: 'target-source', created_at: new Date(baseTime - 1_000).toISOString(),
    updated_at: new Date(baseTime - 1_000).toISOString(),
  });
  treasuryDb.save(userId, target);

  const search = executeTreasuryTool(userId, 'treasury_search', {
    query: 'cap-sentinel', source_labels: ['target-source'], limit: 20,
  }) as { items: Array<{ id: string }>; truncated: boolean };
  assert.deepEqual(search.items.map((entry) => entry.id), [target.id]);
  assert.equal(search.truncated, false);
});
