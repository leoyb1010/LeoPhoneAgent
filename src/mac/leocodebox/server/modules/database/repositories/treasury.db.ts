import { createHash, randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export const TREASURE_KINDS = [
  'link', 'text', 'note', 'image', 'document', 'audio', 'video', 'artifact',
] as const;
const READING_STATES = new Set(['none', 'unread', 'reading', 'read']);
const PROCESSING_STATES = new Set(['saved', 'queued', 'processing', 'ready', 'partial', 'failed']);
const SYNC_STATES = new Set(['local', 'pending', 'synced', 'conflict', 'remote_only']);
const TREASURE_ITEM_REMOTE_LIMIT = 50_000;
export type TreasureKind = (typeof TREASURE_KINDS)[number];
export type ReadingState = 'unread' | 'reading' | 'read' | 'none';
export type ProcessingState = 'saved' | 'queued' | 'processing' | 'ready' | 'partial' | 'failed';
export type SyncState = 'local' | 'pending' | 'synced' | 'conflict' | 'remote_only';
export type TreasureJobType = 'metadata' | 'extract_text' | 'ocr' | 'transcribe' | 'summarize' | 'tag' | 'index' | 'sync';

export type TreasureItem = {
  id: string;
  schema_version: number;
  kind: TreasureKind;
  title: string | null;
  source_uri: string | null;
  source_app: string | null;
  source_label: string;
  original_text: string | null;
  body_ref: string | null;
  preview_ref: string | null;
  mime_type: string | null;
  byte_count: number;
  content_digest: string | null;
  summary: string | null;
  annotation: string | null;
  tags: string[];
  collection_ids: string[];
  pinned: boolean;
  archived: boolean;
  reading_state: ReadingState;
  reading_progress: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  processing_state: ProcessingState;
  processing_error_code: string | null;
  sync_state: SyncState;
  origin_device_id: string;
  deleted_at: string | null;
};

export type TreasureJob = {
  id: string; item_id: string; job_type: TreasureJobType; state: string;
  attempt_count: number; next_attempt_at: string | null; created_at: string;
  updated_at: string; last_error_code: string | null;
};

export type TreasureChange = {
  sequence: number; change_id: string; item_id: string; operation: 'upsert' | 'delete';
  updated_at: string; origin_device_id: string; payload_digest: string;
};

export type RemoteTreasureMetadata = {
  id: string; kind: TreasureKind; title: string; source_uri: string; source_app: string;
  source_label: string; summary: string; annotation: string; tags: string[];
  collection_ids: string[]; pinned: boolean; archived: boolean; reading_state: ReadingState;
  reading_progress: number; created_at: number; updated_at: number; last_opened_at: number;
  processing_state: ProcessingState; processing_error_code: string; content_digest: string;
  byte_count: number; mime_type: string; body_available: boolean; attachment_available: boolean;
  origin_device_id: string; deleted_at: number;
};

export type RemoteTreasureChange = {
  sequence: number; change_id: string; item_id: string; operation: 'upsert' | 'delete';
  updated_at: number; origin_device_id: string; payload_digest: string;
  item: RemoteTreasureMetadata | null;
};

export type RemoteTreasureAsset = {
  scope: string; item_id: string; asset_kind: 'body' | 'attachment';
  content_text: string | null; file_path: string | null; digest: string;
  byte_count: number; mime_type: string; updated_at: number;
};

export type TreasureHighlight = {
  id: string; item_id: string; quote_text: string; note: string | null;
  start_offset: number; end_offset: number; page_number: number | null;
  created_at: string; updated_at: string; origin_device_id: string;
};

export type TreasuryQuerySpec = {
  textQuery: string; kinds: Set<string>; processingStates: Set<string>;
  readingStates: Set<string>; tags: Set<string>; pinned: boolean | null;
  archived: boolean; recent: boolean; after: string | null; before: string | null;
};

export type TreasuryAgentSearchFilters = {
  kinds?: Set<string>;
  tags?: Set<string>;
  sourceLabels?: Set<string>;
  collectionIds?: Set<string>;
  readingState?: ReadingState | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
};

type ItemRow = Omit<TreasureItem, 'tags' | 'collection_ids' | 'pinned' | 'archived'> & {
  user_id: number; normalized_url_key: string | null; tags_json: string;
  collection_ids_json: string; pinned: number; archived: number;
};

const ITEM_COLUMNS = `id, user_id, schema_version, kind, title, source_uri,
  normalized_url_key, source_app, source_label, original_text, body_ref, preview_ref,
  mime_type, byte_count, content_digest, summary, annotation, tags_json,
  collection_ids_json, pinned, archived, reading_state, reading_progress, created_at,
  updated_at, last_opened_at, processing_state, processing_error_code, sync_state,
  origin_device_id, deleted_at`;
const QUALIFIED_ITEM_COLUMNS = ITEM_COLUMNS.split(',')
  .map((column) => `treasure_items.${column.trim()}`)
  .join(', ');

const parseArray = (raw: string): string[] => {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

const rowToItem = (row: ItemRow): TreasureItem => ({
  id: row.id,
  schema_version: row.schema_version,
  kind: row.kind,
  title: row.title,
  source_uri: row.source_uri,
  source_app: row.source_app,
  source_label: row.source_label,
  original_text: row.original_text,
  body_ref: row.body_ref,
  preview_ref: row.preview_ref,
  mime_type: row.mime_type,
  byte_count: row.byte_count,
  content_digest: row.content_digest,
  summary: row.summary,
  annotation: row.annotation,
  tags: parseArray(row.tags_json),
  collection_ids: parseArray(row.collection_ids_json),
  pinned: Boolean(row.pinned),
  archived: Boolean(row.archived),
  reading_state: row.reading_state,
  reading_progress: row.reading_progress,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_opened_at: row.last_opened_at,
  processing_state: row.processing_state,
  processing_error_code: row.processing_error_code,
  sync_state: row.sync_state,
  origin_device_id: row.origin_device_id,
  deleted_at: row.deleted_at,
});

const normalizeTags = (tags: string[]): string[] => {
  const seen = new Set<string>();
  return tags.flatMap((raw) => {
    const tag = raw.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
};

export const normalizeTreasuryUrl = (raw: string): string | null => {
  try {
    const value = new URL(raw);
    if ((value.protocol !== 'http:' && value.protocol !== 'https:') || value.username || value.password) return null;
    value.hash = '';
    value.hostname = value.hostname.toLowerCase();
    const retained = [...value.searchParams.entries()]
      .filter(([name]) => !name.toLowerCase().startsWith('utm_') &&
        !['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(name.toLowerCase()))
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    value.search = '';
    for (const [name, entry] of retained) value.searchParams.append(name, entry);
    return value.toString();
  } catch {
    return null;
  }
};

export const isSafeTreasuryRef = (value: string | null): boolean => {
  if (value === null) return true;
  if (!value || value.includes('\0') || value.startsWith('/') || value.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..');
};

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const isoNow = (): string => new Date().toISOString();

const validateItem = (item: TreasureItem): TreasureItem => {
  if (!TREASURE_KINDS.includes(item.kind)) throw new Error('Unsupported treasure kind');
  if (!Number.isFinite(item.reading_progress) || item.reading_progress < 0 || item.reading_progress > 1) {
    throw new Error('reading_progress must be between 0 and 1');
  }
  if (item.byte_count < 0 || !Number.isSafeInteger(item.byte_count)) throw new Error('Invalid byte_count');
  if (!READING_STATES.has(item.reading_state)) throw new Error('Invalid reading_state');
  if (!PROCESSING_STATES.has(item.processing_state)) throw new Error('Invalid processing_state');
  if (!SYNC_STATES.has(item.sync_state)) throw new Error('Invalid sync_state');
  if (item.content_digest !== null && !/^[0-9a-fA-F]{64}$/.test(item.content_digest)) {
    throw new Error('Invalid content_digest');
  }
  if ((item.source_uri !== null || item.kind === 'link') &&
      (item.source_uri === null || normalizeTreasuryUrl(item.source_uri) === null)) {
    throw new Error('Invalid source_uri');
  }
  if (!isSafeTreasuryRef(item.body_ref) || !isSafeTreasuryRef(item.preview_ref)) {
    throw new Error('Unsafe treasury local reference');
  }
  if (!Number.isFinite(Date.parse(item.created_at)) || !Number.isFinite(Date.parse(item.updated_at))) {
    throw new Error('Invalid treasury timestamp');
  }
  if ((item.last_opened_at !== null && !Number.isFinite(Date.parse(item.last_opened_at))) ||
      (item.deleted_at !== null && !Number.isFinite(Date.parse(item.deleted_at)))) {
    throw new Error('Invalid optional treasury timestamp');
  }
  return { ...item, tags: normalizeTags(item.tags), collection_ids: [...new Set(item.collection_ids)] };
};

const insertChange = (item: TreasureItem, operation: 'upsert' | 'delete'): void => {
  getConnection().prepare(
    `INSERT INTO treasure_changes
     (change_id,item_id,operation,updated_at,origin_device_id,payload_digest)
     VALUES(?,?,?,?,?,?)`,
  ).run(randomUUID(), item.id, operation, isoNow(), item.origin_device_id,
    digest(operation === 'delete' ? `delete:${item.id}:${item.updated_at}` : JSON.stringify(item)));
};

const enqueueDefaultJobs = (item: TreasureItem): void => {
  const types: TreasureJobType[] = item.kind === 'link'
    ? ['metadata', 'index']
    : item.kind === 'document' && ['queued', 'processing'].includes(item.processing_state)
      ? ['extract_text', 'index'] : ['index'];
  const now = isoNow();
  const statement = getConnection().prepare(
    `INSERT INTO treasure_jobs
     (id,item_id,job_type,state,attempt_count,created_at,updated_at)
     SELECT ?,?,?,?,0,?,?
     WHERE NOT EXISTS (
       SELECT 1 FROM treasure_jobs WHERE item_id=? AND job_type=? AND state IN ('queued','processing')
     )`,
  );
  for (const type of types) {
    statement.run(randomUUID(), item.id, type, type === 'index' ? 'completed' : 'queued',
      now, now, item.id, type);
  }
};

const upsertStatement = () => getConnection().prepare(`
  INSERT INTO treasure_items (${ITEM_COLUMNS})
  VALUES (@id,@user_id,@schema_version,@kind,@title,@source_uri,@normalized_url_key,
    @source_app,@source_label,@original_text,@body_ref,@preview_ref,@mime_type,@byte_count,
    @content_digest,@summary,@annotation,@tags_json,@collection_ids_json,@pinned,@archived,
    @reading_state,@reading_progress,@created_at,@updated_at,@last_opened_at,@processing_state,
    @processing_error_code,@sync_state,@origin_device_id,@deleted_at)
  ON CONFLICT(id) DO UPDATE SET
    schema_version=excluded.schema_version, kind=excluded.kind, title=excluded.title,
    source_uri=excluded.source_uri, normalized_url_key=excluded.normalized_url_key,
    source_app=excluded.source_app, source_label=excluded.source_label,
    original_text=excluded.original_text, body_ref=excluded.body_ref,
    preview_ref=excluded.preview_ref, mime_type=excluded.mime_type,
    byte_count=excluded.byte_count, content_digest=excluded.content_digest,
    summary=excluded.summary, annotation=excluded.annotation, tags_json=excluded.tags_json,
    collection_ids_json=excluded.collection_ids_json, pinned=excluded.pinned,
    archived=excluded.archived, reading_state=excluded.reading_state,
    reading_progress=excluded.reading_progress, updated_at=excluded.updated_at,
    last_opened_at=excluded.last_opened_at, processing_state=excluded.processing_state,
    processing_error_code=excluded.processing_error_code, sync_state=excluded.sync_state,
    origin_device_id=excluded.origin_device_id, deleted_at=excluded.deleted_at
`);

const itemBindings = (userId: number, item: TreasureItem) => ({
  ...item,
  user_id: userId,
  normalized_url_key: item.source_uri ? normalizeTreasuryUrl(item.source_uri) : null,
  tags_json: JSON.stringify(item.tags),
  collection_ids_json: JSON.stringify(item.collection_ids),
  pinned: item.pinned ? 1 : 0,
  archived: item.archived ? 1 : 0,
});

const ftsExpression = (raw: string): string => raw.trim().slice(0, 512).split(/\s+/)
  .filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');

const QUERY_KINDS = new Set<string>(TREASURE_KINDS);
const QUERY_PROCESSING = new Set(PROCESSING_STATES);
const QUERY_READING = new Set(READING_STATES);
const dayStart = (raw: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const value = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().startsWith(raw) ? value.toISOString() : null;
};

export const parseTreasuryQuery = (raw: string): TreasuryQuerySpec => {
  const text: string[] = [];
  const kinds = new Set<string>();
  const processingStates = new Set<string>();
  const readingStates = new Set<string>();
  const tags = new Set<string>();
  let pinned: boolean | null = null;
  let archived = false;
  let recent = false;
  let after: string | null = null;
  let before: string | null = null;
  for (const token of raw.trim().slice(0, 512).split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(':');
    if (separator <= 0) { text.push(token); continue; }
    const name = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).trim().toLowerCase();
    const values = value.split(',').filter(Boolean);
    let consumed = false;
    if (name === 'type' || name === 'kind') {
      const valid = values.filter((entry) => QUERY_KINDS.has(entry));
      valid.forEach((entry) => kinds.add(entry)); consumed = valid.length > 0;
    } else if (name === 'state' || name === 'process') {
      const valid = values.filter((entry) => QUERY_PROCESSING.has(entry));
      valid.forEach((entry) => processingStates.add(entry)); consumed = valid.length > 0;
    } else if (name === 'read' || name === 'reading') {
      const valid = values.filter((entry) => QUERY_READING.has(entry));
      valid.forEach((entry) => readingStates.add(entry)); consumed = valid.length > 0;
    } else if (name === 'tag' && values.length) {
      values.forEach((entry) => tags.add(entry.slice(0, 100))); consumed = true;
    } else if (name === 'is') {
      if (value === 'pinned') { pinned = true; consumed = true; }
      else if (value === 'unpinned') { pinned = false; consumed = true; }
      else if (value === 'archived') { archived = true; consumed = true; }
      else if (value === 'recent') { recent = true; consumed = true; }
    } else if (name === 'after') {
      after = dayStart(value); consumed = after !== null;
    } else if (name === 'before') {
      before = dayStart(value); consumed = before !== null;
    }
    if (!consumed) text.push(token);
  }
  return { textQuery: text.join(' '), kinds, processingStates, readingStates, tags,
    pinned, archived, recent, after, before };
};

const queryItems = (userId: number, raw: string, limit: number,
                    includeArchived = false,
                    filters: TreasuryAgentSearchFilters = {}): Array<TreasureItem & { score: number }> => {
  const spec = parseTreasuryQuery(raw);
  const expression = ftsExpression(spec.textQuery);
  const parameters: Array<string | number> = [];
  const from = expression
    ? 'treasure_search_fts JOIN treasure_items ON treasure_items.rowid=treasure_search_fts.rowid'
    : 'treasure_items';
  const where = ['treasure_items.user_id=?', 'treasure_items.deleted_at IS NULL'];
  parameters.push(userId);
  if (expression) { where.push('treasure_search_fts MATCH ?'); parameters.push(expression); }
  if (spec.archived) where.push('treasure_items.archived=1');
  else if (!includeArchived) where.push('treasure_items.archived=0');
  const addSet = (column: string, values: Set<string>) => {
    if (!values.size) return;
    where.push(`${column} IN (${[...values].map(() => '?').join(',')})`);
    parameters.push(...values);
  };
  addSet('treasure_items.kind', spec.kinds);
  addSet('treasure_items.processing_state', spec.processingStates);
  addSet('treasure_items.reading_state', spec.readingStates);
  if (spec.pinned !== null) { where.push('treasure_items.pinned=?'); parameters.push(spec.pinned ? 1 : 0); }
  for (const tag of spec.tags) {
    where.push(`EXISTS (SELECT 1 FROM json_each(treasure_items.tags_json)
      WHERE lower(CAST(json_each.value AS TEXT))=?)`);
    parameters.push(tag.toLowerCase());
  }
  addSet('treasure_items.kind', filters.kinds ?? new Set());
  if (filters.readingState) {
    where.push('treasure_items.reading_state=?');
    parameters.push(filters.readingState);
  }
  if (filters.sourceLabels?.size) {
    where.push(`lower(treasure_items.source_label) IN (${[...filters.sourceLabels].map(() => '?').join(',')})`);
    parameters.push(...filters.sourceLabels);
  }
  for (const tag of filters.tags ?? []) {
    where.push(`EXISTS (SELECT 1 FROM json_each(treasure_items.tags_json)
      WHERE lower(CAST(json_each.value AS TEXT))=?)`);
    parameters.push(tag.toLowerCase());
  }
  for (const collectionId of filters.collectionIds ?? []) {
    where.push(`EXISTS (SELECT 1 FROM json_each(treasure_items.collection_ids_json)
      WHERE CAST(json_each.value AS TEXT)=?)`);
    parameters.push(collectionId);
  }
  if (spec.after) { where.push('treasure_items.created_at>=?'); parameters.push(spec.after); }
  if (spec.before) { where.push('treasure_items.created_at<?'); parameters.push(spec.before); }
  if (filters.createdAfter) {
    where.push('treasure_items.created_at>=?'); parameters.push(filters.createdAfter);
  }
  if (filters.createdBefore) {
    where.push('treasure_items.created_at<?'); parameters.push(filters.createdBefore);
  }
  const rank = expression ? 'bm25(treasure_search_fts)' : '0';
  const order = spec.recent
    ? 'treasure_items.pinned DESC, COALESCE(treasure_items.last_opened_at,\'\') DESC, treasure_items.updated_at DESC'
    : expression ? 'rank, treasure_items.updated_at DESC' : 'treasure_items.pinned DESC, treasure_items.updated_at DESC';
  parameters.push(Math.max(1, Math.min(limit, 500)));
  const rows = getConnection().prepare(
    `SELECT ${QUALIFIED_ITEM_COLUMNS}, ${rank} AS rank FROM ${from}
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
  ).all(...parameters) as Array<ItemRow & { rank: number }>;
  return rows.map((row) => ({ ...rowToItem(row), score: expression ? 1 / (1 + Math.max(0, row.rank)) : 0 }));
};

const listAll = (userId: number): TreasureItem[] => {
  const records: TreasureItem[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const rows = getConnection().prepare(
      `SELECT ${ITEM_COLUMNS} FROM treasure_items
       WHERE user_id=? AND deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
    ).all(userId, pageSize, offset) as ItemRow[];
    records.push(...rows.map(rowToItem));
    if (rows.length < pageSize) return records;
  }
};

export const treasuryDb = {
  save(userId: number, input: TreasureItem): { item: TreasureItem; deduplicated: boolean } {
    const item = validateItem(input);
    const normalizedUrl = item.source_uri ? normalizeTreasuryUrl(item.source_uri) : null;
    const sameId = getConnection().prepare(
      `SELECT ${ITEM_COLUMNS} FROM treasure_items WHERE id=? LIMIT 1`,
    ).get(item.id) as ItemRow | undefined;
    if (sameId && sameId.user_id !== userId) throw new Error('Treasury item id belongs to another user');
    const duplicate = sameId ?? (normalizedUrl
      ? getConnection().prepare(`SELECT ${ITEM_COLUMNS} FROM treasure_items WHERE user_id=? AND normalized_url_key=? AND deleted_at IS NULL LIMIT 1`).get(userId, normalizedUrl) as ItemRow | undefined
      : item.content_digest
        ? getConnection().prepare(`SELECT ${ITEM_COLUMNS} FROM treasure_items WHERE user_id=? AND content_digest=? AND deleted_at IS NULL LIMIT 1`).get(userId, item.content_digest) as ItemRow | undefined
        : undefined);
    if (duplicate) return { item: rowToItem(duplicate), deduplicated: true };

    getConnection().transaction(() => {
      upsertStatement().run(itemBindings(userId, item));
      enqueueDefaultJobs(item);
      insertChange(item, 'upsert');
    })();
    return { item, deduplicated: false };
  },

  update(userId: number, input: TreasureItem): TreasureItem | null {
    const item = validateItem({ ...input, deleted_at: null });
    const existing = getConnection().prepare(
      `SELECT ${ITEM_COLUMNS} FROM treasure_items WHERE user_id=? AND id=?`,
    ).get(userId, item.id) as ItemRow | undefined;
    if (!existing || existing.deleted_at) return null;
    getConnection().transaction(() => {
      upsertStatement().run(itemBindings(userId, item));
      insertChange(item, 'upsert');
    })();
    return item;
  },

  get(userId: number, ids: string[], includeDeleted = false): TreasureItem[] {
    const bounded = [...new Set(ids)].filter(Boolean).slice(0, 100);
    if (!bounded.length) return [];
    const placeholders = bounded.map(() => '?').join(',');
    const deleted = includeDeleted ? '' : 'AND deleted_at IS NULL';
    const rows = getConnection().prepare(
      `SELECT ${ITEM_COLUMNS} FROM treasure_items WHERE user_id=? AND id IN (${placeholders}) ${deleted}`,
    ).all(userId, ...bounded) as ItemRow[];
    return rows.map(rowToItem);
  },

  list(userId: number, limit = 100, offset = 0): TreasureItem[] {
    const rows = getConnection().prepare(
      `SELECT ${ITEM_COLUMNS} FROM treasure_items
       WHERE user_id=? AND deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
    ).all(userId, Math.max(1, Math.min(limit, 500)), Math.max(0, offset)) as ItemRow[];
    return rows.map(rowToItem);
  },

  query(userId: number, query: string, limit = 50): Array<TreasureItem & { score: number }> {
    return queryItems(userId, query, limit);
  },

  search(userId: number, query: string, limit = 50,
         includeArchived = false): Array<TreasureItem & { score: number }> {
    return queryItems(userId, query, Math.min(limit, 500), includeArchived);
  },

  searchForAgent(userId: number, query: string, limit: number,
                 includeArchived: boolean, filters: TreasuryAgentSearchFilters) {
    return queryItems(userId, query, Math.min(limit, 51), includeArchived, filters);
  },

  updateReading(userId: number, id: string, readingState: ReadingState,
    readingProgress: number, opened = true): TreasureItem | null {
    if (!READING_STATES.has(readingState) || !Number.isFinite(readingProgress) ||
        readingProgress < 0 || readingProgress > 1) throw new Error('Invalid reading update');
    const existing = this.get(userId, [id])[0];
    if (!existing) return null;
    const now = isoNow();
    const normalizedProgress = readingState === 'read' ? 1
      : readingState === 'none' || readingState === 'unread' ? 0 : readingProgress;
    const normalizedState: ReadingState = readingState === 'reading' && normalizedProgress >= 1
      ? 'read' : readingState;
    const updated = validateItem({
      ...existing,
      reading_state: normalizedState,
      reading_progress: normalizedProgress,
      last_opened_at: opened ? now : existing.last_opened_at,
      updated_at: now,
      sync_state: 'pending',
    });
    getConnection().transaction(() => {
      upsertStatement().run(itemBindings(userId, updated));
      insertChange(updated, 'upsert');
    })();
    return updated;
  },

  applyDocumentExtraction(userId: number, id: string, pages: string[]): TreasureItem | null {
    const existing = this.get(userId, [id])[0];
    if (!existing) return null;
    const chunks: Array<{
      item_id: string; chunk_index: number; section_label: string;
      text: string; start_offset: number; end_offset: number;
    }> = [];
    let body = '';
    for (const [index, raw] of pages.slice(0, 500).entries()) {
      const text = raw.trim().slice(0, 200_000);
      if (!text) continue;
      const marker = `【第 ${index + 1} 页】\n`;
      if (body.length + marker.length + text.length > 2_000_000) break;
      const start = body.length;
      body += `${marker}${text}\n`;
      chunks.push({
        item_id: id, chunk_index: chunks.length, section_label: `page:${index + 1}`,
        text, start_offset: start + marker.length, end_offset: start + marker.length + text.length,
      });
    }
    body = body.trimEnd();
    if (!body || !chunks.length) return null;
    const now = isoNow();
    const updated = validateItem({
      ...existing, original_text: body, processing_state: 'ready', processing_error_code: null,
      updated_at: now, sync_state: 'pending',
    });
    getConnection().transaction(() => {
      upsertStatement().run(itemBindings(userId, updated));
      getConnection().prepare('DELETE FROM treasure_chunks WHERE item_id=?').run(id);
      const insert = getConnection().prepare(
        `INSERT INTO treasure_chunks
         (item_id,chunk_index,section_label,text,start_offset,end_offset)
         VALUES(@item_id,@chunk_index,@section_label,@text,@start_offset,@end_offset)`,
      );
      for (const chunk of chunks) insert.run(chunk);
      getConnection().prepare(
        `UPDATE treasure_jobs SET state='completed',next_attempt_at=NULL,updated_at=?,last_error_code=NULL
         WHERE item_id=? AND job_type='extract_text' AND state IN ('queued','failed','processing')`,
      ).run(now, id);
      insertChange(updated, 'upsert');
    })();
    return updated;
  },

  highlights(userId: number, itemId: string): TreasureHighlight[] {
    return getConnection().prepare(
      `SELECT h.id,h.item_id,h.quote_text,h.note,h.start_offset,h.end_offset,
              h.page_number,h.created_at,h.updated_at,h.origin_device_id
       FROM treasure_highlights h JOIN treasure_items i ON i.id=h.item_id
       WHERE i.user_id=? AND i.id=? AND i.deleted_at IS NULL AND h.deleted_at IS NULL
       ORDER BY COALESCE(h.page_number,0),h.start_offset,h.created_at`,
    ).all(userId, itemId) as TreasureHighlight[];
  },

  addHighlight(userId: number, input: {
    itemId: string; quoteText: string; note?: string | null;
    startOffset: number; endOffset: number; pageNumber?: number | null;
  }): TreasureHighlight {
    const item = this.get(userId, [input.itemId])[0];
    if (!item) throw new Error('Treasury item not found');
    const body = item.original_text ?? '';
    const quote = input.quoteText.slice(0, 20_000);
    if (!Number.isSafeInteger(input.startOffset) || !Number.isSafeInteger(input.endOffset) ||
        input.startOffset < 0 || input.endOffset <= input.startOffset ||
        input.endOffset > body.length || body.slice(input.startOffset, input.endOffset) !== quote) {
      throw new Error('Highlight does not match treasury body');
    }
    const pageNumber = input.pageNumber == null ? null : Number(input.pageNumber);
    if (pageNumber !== null && (!Number.isSafeInteger(pageNumber) || pageNumber < 1)) {
      throw new Error('Invalid highlight page');
    }
    const now = isoNow();
    const highlight: TreasureHighlight = {
      id: randomUUID(), item_id: item.id, quote_text: quote,
      note: input.note?.trim().slice(0, 20_000) || null,
      start_offset: input.startOffset, end_offset: input.endOffset,
      page_number: pageNumber, created_at: now, updated_at: now,
      origin_device_id: item.origin_device_id,
    };
    const updated = { ...item, updated_at: now, sync_state: 'pending' as const };
    getConnection().transaction(() => {
      getConnection().prepare(
        `INSERT INTO treasure_highlights
         (id,item_id,quote_text,note,start_offset,end_offset,page_number,
          created_at,updated_at,origin_device_id,deleted_at)
         VALUES(@id,@item_id,@quote_text,@note,@start_offset,@end_offset,@page_number,
                @created_at,@updated_at,@origin_device_id,NULL)`,
      ).run(highlight);
      upsertStatement().run(itemBindings(userId, updated));
      insertChange(updated, 'upsert');
    })();
    return highlight;
  },

  deleteHighlight(userId: number, itemId: string, highlightId: string): boolean {
    const item = this.get(userId, [itemId])[0];
    if (!item) return false;
    const now = isoNow();
    let changed = false;
    getConnection().transaction(() => {
      changed = getConnection().prepare(
        `UPDATE treasure_highlights SET deleted_at=?,updated_at=?
         WHERE id=? AND item_id=? AND deleted_at IS NULL`,
      ).run(now, now, highlightId, itemId).changes > 0;
      if (!changed) return;
      const updated = { ...item, updated_at: now, sync_state: 'pending' as const };
      upsertStatement().run(itemBindings(userId, updated));
      insertChange(updated, 'upsert');
    })();
    return changed;
  },

  tombstone(userId: number, ids: string[]): number {
    const items = this.get(userId, ids);
    const now = isoNow();
    const update = getConnection().prepare(
      `UPDATE treasure_items SET deleted_at=?, updated_at=?, sync_state='pending'
       WHERE user_id=? AND id=? AND deleted_at IS NULL`,
    );
    let count = 0;
    getConnection().transaction(() => {
      for (const item of items) {
        const result = update.run(now, now, userId, item.id);
        if (result.changes) {
          count += result.changes;
          insertChange({ ...item, updated_at: now, deleted_at: now, sync_state: 'pending' }, 'delete');
        }
      }
    })();
    return count;
  },

  readyJobs(limit = 50, now = isoNow()): TreasureJob[] {
    return getConnection().prepare(
      `SELECT id,item_id,job_type,state,attempt_count,next_attempt_at,created_at,updated_at,last_error_code
       FROM treasure_jobs WHERE state IN ('queued','failed')
       AND attempt_count<5 AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?`,
    ).all(now, Math.max(1, Math.min(limit, 500))) as TreasureJob[];
  },

  readyJobForItem(itemId: string, jobType: TreasureJobType, now = isoNow()): TreasureJob | null {
    return (getConnection().prepare(
      `SELECT id,item_id,job_type,state,attempt_count,next_attempt_at,created_at,updated_at,last_error_code
       FROM treasure_jobs WHERE item_id=? AND job_type=? AND state IN ('queued','failed')
       AND attempt_count<5 AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 1`,
    ).get(itemId, jobType, now) as TreasureJob | undefined) ?? null;
  },

  claimJob(id: string, now = isoNow()): boolean {
    return getConnection().prepare(
      `UPDATE treasure_jobs SET state='processing',attempt_count=attempt_count+1,
       next_attempt_at=NULL,updated_at=?,last_error_code=NULL
       WHERE id=? AND state IN ('queued','failed')`,
    ).run(now, id).changes > 0;
  },

  completeJob(id: string, now = isoNow()): boolean {
    return getConnection().prepare(
      `UPDATE treasure_jobs SET state='completed',next_attempt_at=NULL,
       updated_at=?,last_error_code=NULL WHERE id=?`,
    ).run(now, id).changes > 0;
  },

  failJob(id: string, errorCode: string, now = new Date()): void {
    const row = getConnection().prepare('SELECT attempt_count FROM treasure_jobs WHERE id=?').get(id) as { attempt_count: number } | undefined;
    if (!row) return;
    const attempt = Math.max(1, row.attempt_count);
    const next = new Date(now.getTime() + Math.min(86_400_000, 1_000 * 2 ** Math.min(attempt, 16))).toISOString();
    const safeCode = errorCode.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'unknown';
    getConnection().prepare(
      `UPDATE treasure_jobs SET state='failed',attempt_count=?,next_attempt_at=?,updated_at=?,last_error_code=? WHERE id=?`,
    ).run(attempt, next, now.toISOString(), safeCode, id);
  },

  retryFailedJobs(itemId: string, jobType?: TreasureJobType, now = isoNow()): number {
    const typePredicate = jobType ? ' AND job_type=?' : '';
    return getConnection().prepare(
      `UPDATE treasure_jobs SET state='queued',attempt_count=0,next_attempt_at=NULL,
       updated_at=?,last_error_code=NULL WHERE item_id=? AND state='failed'${typePredicate}`,
    ).run(...(jobType ? [now, itemId, jobType] : [now, itemId])).changes;
  },

  changes(after = 0, limit = 500): TreasureChange[] {
    return getConnection().prepare(
      `SELECT sequence,change_id,item_id,operation,updated_at,origin_device_id,payload_digest
       FROM treasure_changes WHERE sequence>? ORDER BY sequence LIMIT ?`,
    ).all(Math.max(0, after), Math.max(1, Math.min(limit, 1_000))) as TreasureChange[];
  },

  remoteSyncState(scope: string): { cursor: number; uploadCursor: number; lastSuccessAt: number | null } {
    const row = getConnection().prepare(
      `SELECT cursor,upload_cursor,last_success_at FROM treasure_sync_cursors WHERE scope=?`,
    ).get(scope) as { cursor: number; upload_cursor: number; last_success_at: number | null } | undefined;
    return { cursor: row?.cursor ?? 0, uploadCursor: row?.upload_cursor ?? 0,
      lastSuccessAt: row?.last_success_at ?? null };
  },

  setUploadCursor(scope: string, uploadCursor: number): void {
    const now = Date.now() / 1_000;
    getConnection().prepare(
      `INSERT INTO treasure_sync_cursors(scope,cursor,upload_cursor,last_success_at,updated_at)
       VALUES(?,0,?,NULL,?)
       ON CONFLICT(scope) DO UPDATE SET
         upload_cursor=MAX(treasure_sync_cursors.upload_cursor,excluded.upload_cursor),
         updated_at=excluded.updated_at`,
    ).run(scope, Math.max(0, uploadCursor), now);
  },

  applyRemoteChanges(scope: string, changes: RemoteTreasureChange[], nextCursor: number,
                     successAt = Date.now() / 1_000): void {
    const upsert = getConnection().prepare(
      `INSERT INTO treasure_remote_items
       (scope,item_id,origin_device_id,payload_json,server_sequence,updated_at,deleted_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(scope,item_id) DO UPDATE SET
         origin_device_id=excluded.origin_device_id,payload_json=excluded.payload_json,
         server_sequence=excluded.server_sequence,updated_at=excluded.updated_at,
         deleted_at=excluded.deleted_at
       WHERE excluded.server_sequence>treasure_remote_items.server_sequence`,
    );
    getConnection().transaction(() => {
      for (const change of changes) {
        const deletedAt = change.operation === 'delete' ? change.updated_at : change.item?.deleted_at || null;
        const payload = change.item ?? {
          id: change.item_id, origin_device_id: change.origin_device_id,
          updated_at: change.updated_at, deleted_at: change.updated_at,
        };
        upsert.run(scope, change.item_id, change.origin_device_id, JSON.stringify(payload),
          change.sequence, change.updated_at, deletedAt);
      }
      getConnection().prepare(
        `INSERT INTO treasure_sync_cursors(scope,cursor,upload_cursor,last_success_at,updated_at)
         VALUES(?,?,0,?,?)
         ON CONFLICT(scope) DO UPDATE SET cursor=MAX(treasure_sync_cursors.cursor,excluded.cursor),
           last_success_at=excluded.last_success_at,updated_at=excluded.updated_at`,
      ).run(scope, Math.max(0, nextCursor), successAt, successAt);
    })();
  },

  replaceRemoteSnapshot(scope: string, items: Array<RemoteTreasureMetadata & { server_sequence: number }>,
                        serverCursor: number, successAt = Date.now() / 1_000): void {
    const insert = getConnection().prepare(
      `INSERT INTO treasure_remote_items
       (scope,item_id,origin_device_id,payload_json,server_sequence,updated_at,deleted_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    getConnection().transaction(() => {
      getConnection().prepare('DELETE FROM treasure_remote_items WHERE scope=?').run(scope);
      for (const item of items) {
        insert.run(scope, item.id, item.origin_device_id, JSON.stringify(item), item.server_sequence,
          item.updated_at, item.deleted_at || null);
      }
      getConnection().prepare(
        `INSERT INTO treasure_sync_cursors(scope,cursor,upload_cursor,last_success_at,updated_at)
         VALUES(?,?,0,?,?)
         ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor,
           last_success_at=excluded.last_success_at,updated_at=excluded.updated_at`,
      ).run(scope, Math.max(0, serverCursor), successAt, successAt);
    })();
  },

  remoteItems(scope: string, limit = 10_000): RemoteTreasureMetadata[] {
    const rows = getConnection().prepare(
      `SELECT payload_json FROM treasure_remote_items
       WHERE scope=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
    ).all(scope, Math.max(1, Math.min(limit, TREASURE_ITEM_REMOTE_LIMIT))) as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload_json) as RemoteTreasureMetadata];
      } catch {
        return [];
      }
    });
  },

  remoteItemsAllScopes(limit = TREASURE_ITEM_REMOTE_LIMIT): Array<RemoteTreasureMetadata & { scope: string }> {
    const rows = getConnection().prepare(
      `SELECT scope,payload_json FROM treasure_remote_items
       WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, TREASURE_ITEM_REMOTE_LIMIT))) as Array<{
      scope: string; payload_json: string;
    }>;
    return rows.flatMap((row) => {
      try { return [{ ...JSON.parse(row.payload_json) as RemoteTreasureMetadata, scope: row.scope }]; }
      catch { return []; }
    });
  },

  remoteAsset(scope: string, itemId: string, assetKind: 'body' | 'attachment'): RemoteTreasureAsset | null {
    return (getConnection().prepare(
      `SELECT scope,item_id,asset_kind,content_text,file_path,digest,byte_count,mime_type,updated_at
       FROM treasure_remote_assets WHERE scope=? AND item_id=? AND asset_kind=?`,
    ).get(scope, itemId, assetKind) as RemoteTreasureAsset | undefined) ?? null;
  },

  putRemoteAsset(asset: RemoteTreasureAsset): void {
    if (!/^[0-9a-f]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.byte_count) ||
        asset.byte_count < 0 || !['body', 'attachment'].includes(asset.asset_kind)) {
      throw new Error('Invalid remote treasury asset');
    }
    if (asset.asset_kind === 'body' && (asset.content_text === null || asset.file_path !== null)) {
      throw new Error('Invalid remote treasury body cache');
    }
    if (asset.asset_kind === 'body') {
      const bytes = Buffer.from(asset.content_text!, 'utf8');
      if (asset.mime_type !== 'text/plain' || bytes.length !== asset.byte_count ||
          createHash('sha256').update(bytes).digest('hex') !== asset.digest) {
        throw new Error('Invalid remote treasury body integrity');
      }
    }
    if (asset.asset_kind === 'attachment' && (!asset.file_path || asset.content_text !== null)) {
      throw new Error('Invalid remote treasury attachment cache');
    }
    getConnection().prepare(
      `INSERT INTO treasure_remote_assets
       (scope,item_id,asset_kind,content_text,file_path,digest,byte_count,mime_type,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scope,item_id,asset_kind) DO UPDATE SET
         content_text=excluded.content_text,file_path=excluded.file_path,digest=excluded.digest,
         byte_count=excluded.byte_count,mime_type=excluded.mime_type,updated_at=excluded.updated_at`,
    ).run(asset.scope, asset.item_id, asset.asset_kind, asset.content_text, asset.file_path,
      asset.digest, asset.byte_count, asset.mime_type, asset.updated_at);
  },

  rebuildIndex(): void {
    getConnection().transaction(() => {
      getConnection().exec('DELETE FROM treasure_search_fts');
      getConnection().exec(`
        INSERT INTO treasure_search_fts(rowid,item_id,user_id,title,original_text,summary,annotation,tags)
        SELECT rowid,id,user_id,COALESCE(title,''),COALESCE(original_text,''),COALESCE(summary,''),
               COALESCE(annotation,''),tags_json FROM treasure_items WHERE deleted_at IS NULL
      `);
    })();
  },

  exportJson(userId: number): string { return JSON.stringify(listAll(userId), null, 2); },
  exportMarkdown(userId: number): string {
    return listAll(userId).map((item) => {
      const title = item.title?.trim() || item.source_label;
      const source = item.source_uri ? `\n\nSource: ${item.source_uri}` : '';
      const body = item.original_text ? `\n\n${item.original_text}` : '';
      const tags = item.tags.length ? `\n\nTags: ${item.tags.map((tag) => `#${tag}`).join(' ')}` : '';
      return `## ${title}${source}${body}${tags}`;
    }).join('\n\n---\n\n');
  },
  importMarkdown(userId: number, markdown: string, originDeviceId: string): number {
    let count = 0;
    for (const section of markdown.split('\n\n---\n\n')) {
      const lines = section.split(/\r?\n/);
      const headingLine = lines.find((line) => line.trim());
      if (!headingLine) continue;
      const title = headingLine.replace(/^#{1,6}\s*/, '').trim() || null;
      const source = lines.find((line) => line.startsWith('Source: '))?.slice(8).trim();
      const tags = lines.find((line) => line.startsWith('Tags: '))?.slice(6).trim()
        .split(/\s+/).map((tag) => tag.replace(/^#/, '')).filter(Boolean) ?? [];
      const now = isoNow();
      const common = {
        id: randomUUID(), schema_version: 1, title, source_app: 'markdown-import',
        body_ref: null, preview_ref: null, byte_count: 0, content_digest: null,
        summary: null, annotation: null, tags, collection_ids: [], pinned: false,
        archived: false, reading_progress: 0, created_at: now, updated_at: now,
        last_opened_at: null, processing_error_code: null, sync_state: 'local' as const,
        origin_device_id: originDeviceId, deleted_at: null,
      };
      const item: TreasureItem = source && normalizeTreasuryUrl(source)
        ? {
            ...common, kind: 'link', source_uri: source, source_label: new URL(source).hostname,
            original_text: null, mime_type: 'text/html', reading_state: 'unread',
            processing_state: 'queued',
          }
        : {
            ...common, kind: 'text', source_uri: null, source_label: '文本',
            original_text: lines.slice(1)
              .filter((line) => !line.startsWith('Source: ') && !line.startsWith('Tags: '))
              .join('\n').trim(),
            mime_type: 'text/plain', reading_state: 'none', processing_state: 'saved',
          };
      if (!this.save(userId, item).deduplicated) count += 1;
    }
    return count;
  },
  importJson(userId: number, payload: string): number {
    const value: unknown = JSON.parse(payload);
    if (!Array.isArray(value)) throw new Error('Treasury import must be an array');
    const valid: TreasureItem[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      try {
        const item = validateItem(entry as TreasureItem);
        const owner = getConnection().prepare(
          'SELECT user_id FROM treasure_items WHERE id=? LIMIT 1',
        ).get(item.id) as { user_id: number } | undefined;
        if (!owner || owner.user_id === userId) valid.push(item);
      } catch {
        // Bad records are quarantined by omission; valid records still import.
      }
    }
    let count = 0;
    getConnection().transaction(() => {
      for (const entry of valid) {
        const result = this.save(userId, entry);
        if (!result.deduplicated) count += 1;
      }
    })();
    return count;
  },
  importBrowserBookmarksHtml(userId: number, html: string, originDeviceId: string): number {
    const matches = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis);
    let count = 0;
    for (const match of matches) {
      const source = match[1];
      const normalized = normalizeTreasuryUrl(source);
      if (!normalized) continue;
      const now = isoNow();
      const title = match[2].replace(/<[^>]+>/g, '').trim() || null;
      const result = this.save(userId, {
        id: randomUUID(), schema_version: 1, kind: 'link', title, source_uri: source,
        source_app: 'browser-bookmarks', source_label: new URL(source).hostname,
        original_text: null, body_ref: null, preview_ref: null, mime_type: 'text/html',
        byte_count: 0, content_digest: null, summary: null, annotation: null,
        tags: [], collection_ids: [], pinned: false, archived: false,
        reading_state: 'unread', reading_progress: 0, created_at: now, updated_at: now,
        last_opened_at: null, processing_state: 'queued', processing_error_code: null,
        sync_state: 'local', origin_device_id: originDeviceId, deleted_at: null,
      });
      if (!result.deduplicated) count += 1;
    }
    return count;
  },
};
