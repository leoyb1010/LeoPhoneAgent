import { util } from '@kit.ArkTS';
import { SessionStore } from '../store/SessionStore';
import { ChatImage, chatImages, LocalChatMessage } from '../local/LocalProtocol';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { ReplicaAsset, ReplicaAssets } from './ReplicaAssets';
import { ReplicaChange, ReplicaRecord, PortableValue, recordKey, replicaDate, replicaText, textValue } from './SyncProtocol';
import { sessionStore } from '../store/SessionStore';
import { atomicWriteText } from '../store/AtomicFile';

export class SyncedFile {
  key: string = '';
  name: string = '';
  sessionId: string = '';
  sourcePath: string = '';
  sha256: string = '';
  mimeType: string = '';
}

export class FileReplica {
  static supported(type: string): boolean { return type === 'SessionFileV2' || type === 'ArtifactVersionV2'; }

  static load(context: common.Context): SyncedFile[] {
    const path = context.filesDir + '/sync-file-index.json';
    return fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as SyncedFile[] : [];
  }

  static async apply(context: common.Context, change: ReplicaChange, transfers: ReplicaAssets, force: boolean = false): Promise<boolean> {
    if (!FileReplica.supported(change.id.type)) return false;
    const rows = FileReplica.load(context); const key = recordKey(change.id);
    const old = rows.find((row: SyncedFile) => row.key === key);
    const next = rows.filter((row: SyncedFile) => row.key !== key);
    if (change.operation === 'delete') {
      if (old && !next.some((row: SyncedFile) => row.name === old.name)) {
        const path = context.filesDir + '/workspace/' + old.name;
        if (FileReplica.safeName(old.name) && fileIo.accessSync(path) && await ReplicaAssets.digest(path) === old.sha256) fileIo.unlinkSync(path);
      }
      atomicWriteText(context.filesDir + '/sync-file-index.json', JSON.stringify(next)); return true;
    }
    const record = change.record; if (!record) return false;
    const asset = record.assets['asset'] as ReplicaAsset;
    if (!asset || !ReplicaAssets.valid(asset)) return false;
    const source = await transfers.download(asset);
    const relative = replicaText(record, change.id.type === 'SessionFileV2' ? 'relativePath' : 'originalFileName');
    if (!relative || relative.length > 1024 || relative.indexOf('\\') >= 0 || relative.split('/').some((part: string) => part === '..' || part === '.')) throw new Error('同步附件原始路径不安全');
    const base = relative.split('/').pop() ?? 'attachment';
    const name = `sync-${asset.sha256.substring(0, 16)}-${base.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_').substring(0, 100)}`;
    const workspace = context.filesDir + '/workspace';
    if (!fileIo.accessSync(workspace)) fileIo.mkdirSync(workspace);
    const stat = fileIo.lstatSync(workspace); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('同步文件目录不安全');
    const target = workspace + '/' + name;
    if (fileIo.accessSync(target)) {
      if (await ReplicaAssets.digest(target) !== asset.sha256) {
        if (!force) throw new Error('同名同步附件已有本机修改，保留两端原件等待处理');
        fileIo.renameSync(target, target + '.local-' + Date.now()); fileIo.copyFileSync(source, target);
      }
    } else fileIo.copyFileSync(source, target);
    const row = new SyncedFile(); row.key = key; row.name = name; row.sessionId = replicaText(record, 'sessionId');
    row.sourcePath = relative; row.sha256 = asset.sha256; row.mimeType = asset.mimeType || replicaText(record, 'mimeType') || 'application/octet-stream';
    next.push(row); atomicWriteText(context.filesDir + '/sync-file-index.json', JSON.stringify(next)); return true;
  }

  static async capture(context: common.Context, transfers: ReplicaAssets, sourceRecords: Record<string, ReplicaChange>): Promise<ReplicaRecord[]> {
    await sessionStore.reload(context); const records: ReplicaRecord[] = [];
    const synced = FileReplica.load(context);
    for (let i = 0; i < synced.length; i++) {
      const row = synced[i]; const source = sourceRecords[row.key]?.record;
      const path = context.filesDir + '/workspace/' + row.name;
      if (!source || !FileReplica.safeName(row.name) || !fileIo.accessSync(path)) continue;
      const clone = JSON.parse(JSON.stringify(source)) as ReplicaRecord;
      const asset = await transfers.upload(path, 'asset', row.mimeType);
      const oldAsset = source.assets['asset'] as ReplicaAsset;
      if (source.id.type === 'ArtifactVersionV2' && oldAsset && oldAsset.sha256 !== asset.sha256) {
        // 历史版本保持不可变，本机编辑产生新版本和新的当前版本指针。
        records.push(source);
        const artifactId = replicaText(source, 'artifactId');
        clone.id.id = artifactId + ':' + asset.sha256; clone.fields['versionId'] = textValue(clone.id.id);
        const number = new PortableValue(); number.t = 'int'; number.v = Number(source.fields['versionNumber']?.v ?? 0) + 1; clone.fields['versionNumber'] = number;
        clone.fields['sha256'] = textValue(asset.sha256);
        const size = new PortableValue(); size.t = 'int'; size.v = asset.size; clone.fields['byteCount'] = size;
        const parent = sourceRecords['ArtifactV2:' + artifactId]?.record;
        if (parent) {
          const updated = JSON.parse(JSON.stringify(parent)) as ReplicaRecord; updated.fields['currentVersionId'] = textValue(clone.id.id);
          updated.updatedAt = replicaDate(fileIo.statSync(path).mtime * 1000); records.push(updated);
        }
      } else if (source.id.type === 'SessionFileV2') {
        const size = new PortableValue(); size.t = 'int'; size.v = asset.size; clone.fields['fileSize'] = size;
      }
      clone.assets['asset'] = oldAsset && oldAsset.sha256 === asset.sha256 ? oldAsset : asset; clone.updatedAt = replicaDate(fileIo.statSync(path).mtime * 1000); records.push(clone);
    }
    for (let i = 0; i < sessionStore.summaries.length; i++) {
      const session = await sessionStore.get(context, sessionStore.summaries[i].id); if (!session || session.running) continue;
      const names: string[] = []; const images: string[] = [];
      for (let j = 0; j < session.messages.length; j++) {
        const line = session.messages[j];
        for (const media of chatImages(line.images, line.imageB64, line.imageMime, line.imagePath)) {
          if (!media.path || images.indexOf(media.path) >= 0) continue;
          if (!media.path.startsWith(context.filesDir + '/chat-images/') || !FileReplica.safeName(media.path.substring((context.filesDir + '/chat-images/').length))) throw new Error('会话图片引用超出受信任目录');
          const name = media.path.substring(media.path.lastIndexOf('/') + 1);
          const asset = await transfers.upload(media.path, 'asset', media.mime || 'image/jpeg');
          const record = new ReplicaRecord(); record.id.type = 'SessionFileV2'; record.id.id = session.id + ':attachments/' + name;
          record.fields['sessionId'] = textValue(session.id); record.fields['relativePath'] = textValue('attachments/' + name); record.fields['mimeType'] = textValue(asset.mimeType);
          const size = new PortableValue(); size.t = 'int'; size.v = asset.size; record.fields['fileSize'] = size;
          record.assets['asset'] = asset; record.updatedAt = replicaDate(fileIo.statSync(media.path).mtime * 1000); records.push(record); images.push(media.path);
        }
        for (let k = 0; k < line.files.length; k++) if (names.indexOf(line.files[k]) < 0) names.push(line.files[k]);
      }
      for (let j = 0; j < names.length; j++) {
        const name = names[j]; if (!FileReplica.safeName(name) || synced.some((file: SyncedFile) => file.sessionId === session.id && file.name === name)) continue;
        const path = context.filesDir + '/workspace/' + name; if (!fileIo.accessSync(path)) continue;
        const asset = await transfers.upload(path, 'asset', 'application/octet-stream');
        const record = new ReplicaRecord(); record.id.type = 'SessionFileV2'; record.id.id = session.id + ':' + name;
        record.fields['sessionId'] = textValue(session.id); record.fields['relativePath'] = textValue(name);
        record.fields['mimeType'] = textValue(asset.mimeType);
        const size = new PortableValue(); size.t = 'int'; size.v = asset.size; record.fields['fileSize'] = size;
        record.assets['asset'] = asset; record.updatedAt = replicaDate(fileIo.statSync(path).mtime * 1000); records.push(record);
      }
    }
    return records;
  }

  static async relink(context: common.Context): Promise<void> {
    const files = FileReplica.load(context); await sessionStore.reload(context);
    for (let i = 0; i < sessionStore.summaries.length; i++) {
      const session = await sessionStore.get(context, sessionStore.summaries[i].id); if (!session || session.running) continue;
      let changed = false;
      for (let j = 0; j < session.messages.length; j++) {
        const line = session.messages[j];
        const existing = line.files.filter((name: string) => FileReplica.safeName(name) && fileIo.accessSync(context.filesDir + '/workspace/' + name));
        if (existing.length !== line.files.length) { line.files = existing; changed = true; }
        if (!line.syncPartsJson) continue;
        const parts = JSON.parse(line.syncPartsJson) as Record<string, Object>[];
        if (!Array.isArray(parts)) continue;
        for (let k = 0; k < parts.length; k++) {
          if (parts[k]['type'] !== 'mediaRef') continue;
          const media = parts[k]['value'] as Record<string, Object>; const relative = `${media['relativePath'] ?? ''}`;
          const file = files.find((item: SyncedFile) => item.sessionId === session.id &&
            (relative === item.sourcePath || relative === session.id + '/' + item.sourcePath));
          if (!file) continue;
          const mediaId = typeof media['id'] === 'string' ? media['id'] as string : relative;
          if ((file.mimeType === 'image/png' || file.mimeType === 'image/jpeg') && !line.images.some((image: ChatImage) => image.sourceId === mediaId)) {
            const path = context.filesDir + '/workspace/' + file.name;
            const parent = fileIo.lstatSync(context.filesDir + '/workspace'); const leaf = fileIo.lstatSync(path);
            if (!parent.isDirectory() || parent.isSymbolicLink() || !leaf.isFile() || leaf.isSymbolicLink() || leaf.size > 8 * 1024 * 1024) continue;
            const source = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
            try {
              const buffer = new ArrayBuffer(fileIo.statSync(source.fd).size);
              if (fileIo.readSync(source.fd, buffer) !== buffer.byteLength) throw new Error('同步图片读取不完整');
              const image = new ChatImage(); image.path = SessionStore.writeImageBytes(context, buffer, file.mimeType); image.mime = file.mimeType;
              image.sourceId = mediaId; image.contentHash = file.sha256; line.images.push(image); changed = true;
            } finally { fileIo.closeSync(source); }
          } else if (file.mimeType !== 'image/png' && file.mimeType !== 'image/jpeg' && line.files.indexOf(file.name) < 0) { line.files.push(file.name); changed = true; }
        }
      }
      if (changed) await sessionStore.replaceMessages(context, session, false);
    }
    await sessionStore.reload(context);
  }

  static safeName(name: string): boolean { return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[\/\\\0]/.test(name); }
}
