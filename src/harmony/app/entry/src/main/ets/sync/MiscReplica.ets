import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { deviceInfo } from '@kit.BasicServicesKit';
import { atomicWriteText } from '../store/AtomicFile';
import { CollectionItem, collectionStore } from '../store/CollectionStore';
import { sessionStore, SessionStore } from '../store/SessionStore';
import { LocalChatMessage } from '../local/LocalProtocol';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { ReplicaChange, ReplicaRecord, PortableValue, replicaDate, replicaText, textValue, APPLE_EPOCH_MS } from './SyncProtocol';
import { ReplicaAsset, ReplicaAssets } from './ReplicaAssets';

class MemoryEntry { timestamp: string = ''; content: string = ''; }
const TYPES: string[] = ['MemoryDailyV2', 'SyncDeviceV2', 'ArtifactV2', 'CompactMarkerV2'];

export class MiscReplica {
  static supported(type: string): boolean { return TYPES.indexOf(type) >= 0; }

  static async apply(context: common.Context, change: ReplicaChange): Promise<boolean> {
    if (!MiscReplica.supported(change.id.type)) return false;
    const record = change.record;
    if (change.id.type === 'SyncDeviceV2') return true;
    if (change.id.type === 'ArtifactV2') {
      await collectionStore.load(context);
      const next = collectionStore.items.filter((item: CollectionItem) => item.id !== change.id.id);
      if (change.operation !== 'delete' && record && record.fields['trashedAt']?.t !== 'date') {
        const old = collectionStore.items.find((item: CollectionItem) => item.id === change.id.id);
        const item = new CollectionItem(); item.id = change.id.id; item.title = replicaText(record, 'title') || '同步产物';
        item.body = old?.body ?? '同步产物，原件保存在沙箱文件中'; item.createdAt = MiscReplica.date(record, 'createdAt'); next.push(item);
      }
      const headsPath = context.filesDir + '/sync-artifact-heads.json';
      const heads: Record<string, string> = fileIo.accessSync(headsPath) ? JSON.parse(fileIo.readTextSync(headsPath)) as Record<string, string> : {};
      if (record) heads[change.id.id] = replicaText(record, 'currentVersionId');
      const synced = next.find((item: CollectionItem) => item.id === change.id.id);
      if (synced) heads['body:' + change.id.id] = synced.body;
      atomicWriteText(headsPath, JSON.stringify(heads));
      atomicWriteText(context.filesDir + '/collections.json', JSON.stringify(next)); await collectionStore.load(context); return true;
    }
    if (change.id.type === 'MemoryDailyV2') {
      const key = record ? replicaText(record, 'dateKey') : change.id.id;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('每日记忆日期无效');
      const directory = context.filesDir + '/memory'; if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory);
      const path = directory + '/' + key + '.md';
      if (change.operation === 'delete') { if (fileIo.accessSync(path)) fileIo.unlinkSync(path); return true; }
      if (!record) return false;
      const remote = JSON.parse(replicaText(record, 'entriesJson') || '[]') as MemoryEntry[];
      if (!Array.isArray(remote) || remote.some((entry: MemoryEntry) => !entry || typeof entry.timestamp !== 'string' || typeof entry.content !== 'string')) throw new Error('每日记忆条目格式无效');
      const local = fileIo.accessSync(path) ? MiscReplica.parseMemory(fileIo.readTextSync(path)) : [];
      atomicWriteText(path, MiscReplica.serializeMemory(local.concat(remote))); return true;
    }
    const previous = record;
    if (!previous) return change.operation === 'delete';
    const id = replicaText(previous, 'sessionId'); if (!SessionStore.validId(id)) return false;
    const session = await sessionStore.get(context, id); if (!session || session.running) return false;
    const lines = session.messages.filter((line: LocalChatMessage) => line.syncId !== change.id.id || line.kind !== 'summary');
    if (change.operation !== 'delete') {
      const marker = new LocalChatMessage(); marker.syncId = change.id.id; marker.kind = 'summary'; marker.role = 'system';
      marker.text = replicaText(previous, 'summary'); marker.count = Number(previous.fields['compactedCount']?.v ?? 0);
      marker.at = MiscReplica.date(previous, 'createdAt');
      const kept = replicaText(previous, 'firstKeptMessageId');
      let boundary = kept ? lines.findIndex((line: LocalChatMessage) => line.syncId === kept) : -1;
      if (kept && boundary < 0) return false;
      if (boundary < 0) boundary = Math.min(lines.length, Math.max(0, Number(previous.fields['firstKeptSortOrder']?.v ?? 0)));
      lines.splice(boundary, 0, marker);
    }
    session.messages = lines; atomicWriteText(`${context.filesDir}/sessions/${id}.json`, JSON.stringify(session)); await sessionStore.reload(context); return true;
  }

  static async applyVersion(context: common.Context, change: ReplicaChange, transfers: ReplicaAssets): Promise<boolean> {
    const record = change.record; if (!record || change.operation === 'delete') return false;
    const id = replicaText(record, 'artifactId'); if (!id) return false;
    const asset = record.assets['asset'] as ReplicaAsset;
    if (!asset) return false;
    const headsPath = context.filesDir + '/sync-artifact-heads.json';
    const heads: Record<string, string> = fileIo.accessSync(headsPath) ? JSON.parse(fileIo.readTextSync(headsPath)) as Record<string, string> : {};
    if (!heads[id]) return false;
    if (heads[id] !== change.id.id) return true;
    const mime = replicaText(record, 'mimeType') || asset.mimeType;
    if (!mime.startsWith('text/') && mime !== 'application/json') return true;
    if (asset.size > 8 * 1024 * 1024) return false;
    const path = await transfers.download(asset); const body = fileIo.readTextSync(path);
    await collectionStore.load(context);
    const item = collectionStore.items.find((row: CollectionItem) => row.id === id);
    if (!item) return false;
    item.body = body; heads['body:' + id] = body;
    atomicWriteText(headsPath, JSON.stringify(heads));
    atomicWriteText(context.filesDir + '/collections.json', JSON.stringify(collectionStore.items)); return true;
  }

  static async ensureCollectionSession(context: common.Context): Promise<string> {
    await collectionStore.load(context); if (collectionStore.jsonLoadFailed) throw new Error('收藏档案读取失败，本次保留远端数据');
    if (!collectionStore.items.length) return '';
    const path = context.filesDir + '/sync-collection-session.json';
    if (fileIo.accessSync(path)) {
      const id = fileIo.readTextSync(path); if (SessionStore.validId(id) && await sessionStore.get(context, id)) return id;
    }
    const session = await sessionStore.create(context, '手机收藏'); atomicWriteText(path, session.id); return session.id;
  }

  static async capture(context: common.Context, deviceId: string, transfers: ReplicaAssets, sourceRecords: Record<string, ReplicaChange>): Promise<ReplicaRecord[]> {
    const output: ReplicaRecord[] = []; const now = replicaDate(Date.now());
    const device = MiscReplica.record('SyncDeviceV2', deviceId, now);
    device.fields['deviceId'] = textValue(deviceId); device.fields['deviceName'] = textValue(deviceInfo.marketName);
    device.fields['osVersion'] = textValue(deviceInfo.osFullName); device.fields['uploadTypes'] = textValue('Sessions,Messages,Files,Skills,Providers,MCP,Memory,Artifacts');
    device.fields['lastSeen'] = MiscReplica.dateField(Date.now()); device.fields['appVersion'] = MiscReplica.integer(ReleaseCatalog.currentBuild); output.push(device);
    const memory = context.filesDir + '/memory';
    if (fileIo.accessSync(memory)) {
      const names = fileIo.listFileSync(memory); const cutoff = Date.now() - 30 * 86400000;
      for (let i = 0; i < names.length; i++) {
        const name = names[i]; if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name) || Date.parse(name.substring(0, 10)) < cutoff) continue;
        const path = memory + '/' + name; const entries = MiscReplica.parseMemory(fileIo.readTextSync(path)); if (!entries.length) continue;
        const record = MiscReplica.record('MemoryDailyV2', name.slice(0, -3), replicaDate(fileIo.statSync(path).mtime * 1000));
        record.fields['dateKey'] = textValue(name.slice(0, -3)); record.fields['entriesJson'] = textValue(JSON.stringify(entries)); output.push(record);
      }
    }
    await sessionStore.reload(context);
    for (let i = 0; i < sessionStore.summaries.length; i++) {
      const session = await sessionStore.get(context, sessionStore.summaries[i].id); if (!session || session.running) continue;
      for (let j = 0; j < session.messages.length; j++) {
        const line = session.messages[j]; if (line.kind !== 'summary' || !line.syncId) continue;
        const marker = MiscReplica.record('CompactMarkerV2', line.syncId, replicaDate(session.updatedAt));
        marker.fields['markerId'] = textValue(line.syncId); marker.fields['sessionId'] = textValue(session.id); marker.fields['summary'] = textValue(line.text);
        marker.fields['compactedCount'] = MiscReplica.integer(line.count); marker.fields['firstKeptSortOrder'] = MiscReplica.integer(j + 1);
        marker.fields['createdAt'] = MiscReplica.dateField(line.at || session.updatedAt);
        const firstKept = session.messages[j + 1]?.syncId; marker.fields['markerVersion'] = MiscReplica.integer(firstKept ? 2 : 1);
        if (firstKept) marker.fields['firstKeptMessageId'] = textValue(firstKept); output.push(marker);
      }
    }
    const parent = await MiscReplica.ensureCollectionSession(context);
    if (parent) {
      const directory = context.filesDir + '/sync-artifact-source'; if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory);
      for (let i = 0; i < collectionStore.items.length; i++) {
        const item = collectionStore.items[i];
        const headsPath = context.filesDir + '/sync-artifact-heads.json';
        const heads: Record<string, string> = fileIo.accessSync(headsPath) ? JSON.parse(fileIo.readTextSync(headsPath)) as Record<string, string> : {};
        if (heads[item.id] && heads['body:' + item.id] === item.body) {
          const source = sourceRecords['ArtifactV2:' + item.id]?.record;
          if (source) output.push(source);
          continue;
        }
        const path = directory + '/' + i + '.md'; atomicWriteText(path, item.body);
        const asset = await transfers.upload(path, 'asset', 'text/markdown');
        const versionId = item.id + ':' + asset.sha256;
        const artifact = MiscReplica.record('ArtifactV2', item.id, now);
        artifact.fields['artifactId'] = textValue(item.id); artifact.fields['sessionId'] = textValue(parent); artifact.fields['title'] = textValue(item.title);
        artifact.fields['kind'] = textValue('file'); artifact.fields['mimeType'] = textValue('text/markdown'); artifact.fields['currentVersionId'] = textValue(versionId);
        artifact.fields['createdAt'] = MiscReplica.dateField(item.createdAt || Date.now()); output.push(artifact);
        const version = MiscReplica.record('ArtifactVersionV2', versionId, now);
        version.fields['versionId'] = textValue(versionId); version.fields['artifactId'] = textValue(item.id); version.fields['sessionId'] = textValue(parent);
        version.fields['versionNumber'] = MiscReplica.integer(1); version.fields['originalFileName'] = textValue(item.title.replace(/[\/\\]/g, '_') + '.md');
        version.fields['byteCount'] = MiscReplica.integer(asset.size); version.fields['sha256'] = textValue(asset.sha256); version.fields['mimeType'] = textValue('text/markdown');
        version.fields['createdAt'] = MiscReplica.dateField(item.createdAt || Date.now()); version.assets['asset'] = asset; output.push(version);
      }
    }
    return output;
  }

  static parseMemory(text: string): MemoryEntry[] {
    const lines = text.split('\n'); const entries: MemoryEntry[] = []; let timestamp = ''; let content: string[] = [];
    const flush = (): void => {
      const body = content.join('\n').trim(); if (!body) return;
      const entry = new MemoryEntry(); entry.timestamp = timestamp || 'legacy-' + MiscReplica.hash(body); entry.content = body; entries.push(entry);
    };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('<!-- ') && lines[i].endsWith(' -->')) { flush(); timestamp = lines[i].slice(5, -4); content = []; }
      else content.push(lines[i]);
    }
    flush(); return entries;
  }
  static serializeMemory(entries: MemoryEntry[]): string {
    const unique = entries.filter((entry: MemoryEntry, index: number) => entries.findIndex((other: MemoryEntry) => other.timestamp === entry.timestamp && other.content === entry.content) === index);
    unique.sort((a: MemoryEntry, b: MemoryEntry) => b.timestamp.localeCompare(a.timestamp) || a.content.localeCompare(b.content));
    return unique.map((entry: MemoryEntry) => `<!-- ${entry.timestamp} -->\n${entry.content}\n`).join('\n');
  }
  private static hash(text: string): string { let value = 0; for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0; return `${value}`; }
  private static record(type: string, id: string, date: number): ReplicaRecord { const record = new ReplicaRecord(); record.id.type = type; record.id.id = id; record.updatedAt = date; record.fields['updatedAt'] = MiscReplica.dateField(date * 1000 + APPLE_EPOCH_MS); return record; }
  private static integer(value: number): PortableValue { const field = new PortableValue(); field.t = 'int'; field.v = value; return field; }
  private static dateField(value: number): PortableValue { const field = new PortableValue(); field.t = 'date'; field.v = replicaDate(value); return field; }
  private static date(record: ReplicaRecord, name: string): number { return Number(record.fields[name]?.v ?? record.updatedAt) * 1000 + APPLE_EPOCH_MS; }
}
