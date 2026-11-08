export class PortableValue {
  t: string = 'null';
  v: Object | null = null;
}
export class SyncID { type: string = ''; id: string = ''; }
export class ReplicaRecord {
  id: SyncID = new SyncID();
  fields: Record<string, PortableValue> = {};
  assets: Record<string, Object> = {};
  schemaVersion: number = 1;
  minimumCompatibleVersion: number = 1;
  unknownFields: Record<string, PortableValue> = {};
  updatedAt: number = 0;
}
export class ReplicaChange {
  changeId: string = '';
  revision: number = 0;
  id: SyncID = new SyncID();
  operation: string = 'upsert';
  updatedAt: number = 0;
  record: ReplicaRecord | null = null;
}
export class ReplicaEntry { cursor: number = 0; senderDeviceId: string = ''; change: ReplicaChange = new ReplicaChange(); }
export class ReplicaSkipped { cursor: number = 0; id: string = ''; reason: string = ''; }
export class ReplicaPage {
  quarantine: ReplicaSkipped[] = [];
  replicaId: string = '';
  changes: ReplicaEntry[] = [];
  nextCursor: number = 0;
  hasMore: boolean = false;
}
export const APPLE_EPOCH_MS: number = 978307200000;
export function replicaDate(milliseconds: number): number { return (milliseconds - APPLE_EPOCH_MS) / 1000; }
export function recordKey(id: SyncID): string { return `${id.type}:${id.id}`; }
export function textValue(text: string): PortableValue { const field = new PortableValue(); field.t = 'string'; field.v = text; return field; }
export function replicaText(record: ReplicaRecord, name: string): string {
  const value = record.fields[name]; return value && (value.t === 'string' || value.t === 'json') && typeof value.v === 'string' ? value.v as string : '';
}
export function decodeReplicaPage(raw: string, after: number, knownReplica: string): ReplicaPage {
  if (raw.length > 5 * 1024 * 1024) throw new Error('同步页面超过 5 MB 限制');
  const page = JSON.parse(raw) as ReplicaPage;
  if (!page || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(page.replicaId) || !Array.isArray(page.changes) || page.changes.length > 100 ||
    !Number.isSafeInteger(page.nextCursor) || page.nextCursor < after || typeof page.hasMore !== 'boolean') throw new Error('同步游标响应无效');
  if (knownReplica && after > 0 && page.replicaId !== knownReplica) throw new Error('同步副本身份已变化，请重置游标重新核对');
  let previous = after;
  const original = page.changes; const kept: ReplicaEntry[] = []; page.quarantine = [];
  for (let i = 0; i < original.length; i++) {
    const entry = original[i];
    if (!entry || !Number.isSafeInteger(entry.cursor) || entry.cursor <= previous || entry.cursor > page.nextCursor) throw new Error('同步游标顺序无效');
    previous = entry.cursor;
    if (!validReplicaChange(entry.change)) {
      const skipped = new ReplicaSkipped(); skipped.cursor = entry.cursor; skipped.reason = '记录结构、字段类型或附件描述无效';
      skipped.id = entry.change?.id ? recordKey(entry.change.id) : '';
      page.quarantine.push(skipped); continue;
    }
    kept.push(entry);
  }
  if (page.nextCursor !== previous || (page.hasMore && original.length === 0)) throw new Error('同步页末游标无效');
  page.changes = kept;
  return page;
}
function validTaggedValues(values: Record<string, PortableValue>): boolean {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  const keys = Object.keys(values);
  for (let i = 0; i < keys.length; i++) {
    if (['__proto__', 'prototype', 'constructor'].indexOf(keys[i]) >= 0) return false;
    const field = values[keys[i]];
    if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
    if (field.t === 'null') { if (field.v !== null && field.v !== undefined) return false; }
    else if (field.t === 'string' || field.t === 'json' || field.t === 'data') { if (typeof field.v !== 'string') return false; }
    else if (field.t === 'int') { if (typeof field.v !== 'number' || !Number.isSafeInteger(field.v)) return false; }
    else if (field.t === 'double' || field.t === 'date') { if (typeof field.v !== 'number' || !Number.isFinite(field.v)) return false; }
    else if (field.t === 'bool') { if (typeof field.v !== 'boolean') return false; }
    else return false;
  }
  return true;
}
function validReplicaChange(change: ReplicaChange): boolean {
  if (!change || !change.id || typeof change.id.id !== 'string' || !change.id.id || typeof change.id.type !== 'string' || !change.id.type ||
    !Number.isSafeInteger(change.revision) || change.revision < 0 || typeof change.changeId !== 'string' || !change.changeId ||
    !Number.isFinite(change.updatedAt) || (change.operation !== 'delete' && change.operation !== 'upsert')) return false;
  if (change.operation === 'delete') return true;
  const record = change.record;
  if (!record || record.id?.type !== change.id.type || record.id?.id !== change.id.id || !record.assets || typeof record.assets !== 'object' || Array.isArray(record.assets) ||
    !Number.isFinite(record.updatedAt) || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1 ||
    !validTaggedValues(record.fields) || !validTaggedValues(record.unknownFields)) return false;
  const names = Object.keys(record.assets);
  for (let i = 0; i < names.length; i++) {
    const asset = record.assets[names[i]] as Record<string, Object>;
    if (!asset || typeof asset['key'] !== 'string' || !asset['key'] || typeof asset['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(asset['sha256'] as string) ||
      typeof asset['size'] !== 'number' || !Number.isSafeInteger(asset['size']) || Number(asset['size']) < 0 || Number(asset['size']) > 256 * 1024 * 1024) return false;
  }
  return true;
}

export function normalizeReplicaRoot(raw: string): string {
  const root = raw.trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(root)) return root;
  const match = /^http:\/\/(100\.(\d+)\.\d+\.\d+|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+):[0-9]{1,5}$/.exec(root);
  if (match && (!match[2] || (Number(match[2]) >= 64 && Number(match[2]) <= 127))) return root;
  throw new Error('同步地址需要 HTTPS 源站，或明确端口的本机、局域网、Tailnet 地址');
}
