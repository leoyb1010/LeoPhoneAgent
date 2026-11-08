import { providerStore, ProviderInstance } from '../store/ProviderStore';
import { FailoverSlot } from '../local/LocalProtocol';
import { ChatRuns } from '../local/ChatRun';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';
import { LocalSession, SessionStore, sessionStore } from '../store/SessionStore';
import { ChatImage, chatImages, LocalChatMessage } from '../local/LocalProtocol';
import { ReplicaChange, ReplicaRecord, PortableValue, recordKey, replicaDate, replicaText, textValue, APPLE_EPOCH_MS } from './SyncProtocol';

class DirectSource { modelEntryId: string = ''; compositeKey: string = ''; }
class GroupSource { groupId: string = ''; resolvedEntryId: string = ''; }
class ModelSource { directEntry?: DirectSource; group?: GroupSource; }
class ModelBinding { sessionId: string = ''; primarySource: ModelSource = new ModelSource(); subModelSource?: Object; }
class MediaReference { id: string = ''; relativePath: string = ''; mimeType: string = ''; originalFileName: string = ''; }
class MediaPart { type: string = 'mediaRef'; value: MediaReference = new MediaReference(); }
class TextPart { type: string = 'text'; value: string = ''; }

/** 会话沿用原端稳定 ID；消息文本使用 iOS ContentPart 的 {type,value} 编码。 */
export class SessionReplica {
  static supported(type: string): boolean { return type === 'SessionV2' || type === 'MessageV2'; }

  static async capture(context: common.Context, sourceRecords: Record<string, ReplicaChange> = {}): Promise<ReplicaRecord[]> {
    await sessionStore.reload(context);
    if (sessionStore.jsonLoadFailed) throw new Error('会话目录读取失败，本次保留远端数据');
    const records: ReplicaRecord[] = [];
    for (let i = 0; i < sessionStore.summaries.length; i++) {
      const session = await sessionStore.get(context, sessionStore.summaries[i].id);
      if (!session) throw new Error('会话档案读取失败，本次保留远端数据');
      if (session.running) continue;
      const record = new ReplicaRecord(); record.schemaVersion = 2; record.id.type = 'SessionV2'; record.id.id = session.id;
      record.fields['sessionId'] = textValue(session.id); record.fields['title'] = textValue(session.title);
      const bound = session.modelQueue[0];
      if (bound) {
        const idsPath = context.filesDir + '/sync-config-ids.json';
        const ids: Record<string, string> = fileIo.accessSync(idsPath) ? JSON.parse(fileIo.readTextSync(idsPath)) as Record<string, string> : {};
        const binding = new ModelBinding(); binding.sessionId = session.id;
        const prior = sourceRecords['SessionV2:' + session.id]?.record;
        if (prior && replicaText(prior, 'modelBinding')) binding.subModelSource = (JSON.parse(replicaText(prior, 'modelBinding')) as ModelBinding).subModelSource;
        if (session.modelGroupId) { const group = new GroupSource(); group.groupId = session.modelGroupId; group.resolvedEntryId = bound.instanceId + '/' + bound.model; binding.primarySource.group = group; }
        else { const direct = new DirectSource(); direct.compositeKey = bound.instanceId + '/' + bound.model; direct.modelEntryId = ids[direct.compositeKey] ?? direct.compositeKey; binding.primarySource.directEntry = direct; }
        record.fields['modelBinding'] = textValue(JSON.stringify(binding));
      }
      const previousSession = sourceRecords['SessionV2:' + session.id]?.record;
      if (session.unresolvedModelId && previousSession) {
        if (previousSession.fields['modelBinding']) record.fields['modelBinding'] = previousSession.fields['modelBinding'];
        record.fields['modelId'] = previousSession.fields['modelId'] ?? textValue('');
      } else record.fields['modelId'] = textValue(session.modelQueue[0]?.model ?? session.unresolvedModelId ?? '');
      record.fields['createdAt'] = SessionReplica.dateField(session.messages[0]?.at || session.updatedAt);
      record.fields['updatedAt'] = SessionReplica.dateField(session.updatedAt);
      const memory = new PortableValue(); memory.t = 'int'; memory.v = session.memoryEnabled === false ? 0 : 1; record.fields['memoryEnabled'] = memory;
      if (session.pinned) record.fields['pinnedAt'] = SessionReplica.dateField(session.updatedAt);
      else { const empty = new PortableValue(); empty.t = 'null'; record.fields['pinnedAt'] = empty; }
      record.updatedAt = replicaDate(session.updatedAt); records.push(record);
      let newIds = false;
      for (let j = 0; j < session.messages.length; j++) {
        const line = session.messages[j];
        if (!line.syncId) { line.syncId = util.generateRandomUUID(); newIds = true; }
        if (line.kind === 'summary') continue;
        // 附件引用保存在原端，未完成附件传输前不把本机路径带给其他设备。
        const message = new ReplicaRecord(); message.id.type = 'MessageV2'; message.id.id = line.syncId;
        message.fields['messageId'] = textValue(line.syncId); message.fields['sessionId'] = textValue(session.id);
        message.fields['role'] = textValue(line.role);
        const part = new TextPart(); part.value = line.text;
        const nativeParts: Object[] = [part];
        if (!line.syncPartsJson) {
          for (let k = 0; k < line.files.length; k++) {
            const media = new MediaPart(); media.value.id = line.syncId + '-file-' + k; media.value.relativePath = session.id + '/' + line.files[k]; media.value.originalFileName = line.files[k]; media.value.mimeType = 'application/octet-stream'; nativeParts.push(media);
          }
          const images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
          for (let k = 0; k < images.length; k++) {
            if (!images[k].path.startsWith(context.filesDir + '/chat-images/')) continue;
            const name = images[k].path.substring(images[k].path.lastIndexOf('/') + 1);
            const media = new MediaPart(); media.value.id = images[k].sourceId || line.syncId + '-image-' + k;
            media.value.relativePath = session.id + '/attachments/' + name; media.value.originalFileName = name; media.value.mimeType = images[k].mime;
            nativeParts.push(media);
          }
        }
        let partsJson = JSON.stringify(nativeParts);
        if (line.syncPartsJson) {
          if (line.syncText === line.text) partsJson = line.syncPartsJson;
          else {
            const original = JSON.parse(line.syncPartsJson) as Record<string, Object>[];
            const nextParts: Object[] = [part];
            if (Array.isArray(original)) {
              for (let k = 0; k < original.length; k++) if (original[k]['type'] !== 'text') nextParts.push(original[k]);
            }
            partsJson = JSON.stringify(nextParts);
          }
        }
        message.fields['partsJson'] = textValue(partsJson);
        message.fields['createdAt'] = SessionReplica.dateField(line.at || session.updatedAt);
        message.fields['updatedAt'] = SessionReplica.dateField(session.updatedAt);
        const order = new PortableValue(); order.t = 'int'; order.v = j; message.fields['sortOrder'] = order;
        const interrupted = new PortableValue(); interrupted.t = 'int'; interrupted.v = line.kind === 'partial' ? 1 : 0;
        message.fields['streamInterruptCount'] = interrupted;
        if (line.kind) message.unknownFields['harmonyKind'] = textValue(line.kind);
        message.updatedAt = replicaDate(session.updatedAt); records.push(message);
      }
      if (newIds) atomicWriteText(`${context.filesDir}/sessions/${session.id}.json`, JSON.stringify(session));
    }
    return records;
  }

  static async apply(context: common.Context, change: ReplicaChange, force: boolean = false, sourceRecords: Record<string, ReplicaChange> = {}): Promise<boolean> {
    const type = change.id.type;
    if (!SessionReplica.supported(type)) return false;
    const record = change.record;
    const id = type === 'SessionV2' ? change.id.id : (record ? replicaText(record, 'sessionId') : '');
    if (!SessionStore.validId(id)) return false;
    if (record && record.minimumCompatibleVersion > (type === 'SessionV2' ? 2 : 1)) return false;
    const path = `${context.filesDir}/sessions/${id}.json`;
    const session = await sessionStore.get(context, id) ?? new LocalSession();
    if (session.running) return false;
    if (type === 'SessionV2') {
      if (!force && session.id && replicaDate(session.updatedAt) > change.updatedAt) return false;
      if (change.operation === 'delete') {
        ChatRuns.invalidateIdle(id);
        if (fileIo.accessSync(path)) fileIo.unlinkSync(path);
        await sessionStore.reload(context); return true;
      }
      if (!record) return false;
      session.memoryEnabled = Number(record.fields['memoryEnabled']?.v ?? 1) !== 0;
      session.pinned = record.fields['pinnedAt']?.t === 'date';
      session.id = id; session.title = replicaText(record, 'title') || '同步对话';
      const model = replicaText(record, 'modelId');
      const rawBinding = replicaText(record, 'modelBinding');
      let resolved = false;
      if (rawBinding) {
        const binding = JSON.parse(rawBinding) as ModelBinding;
        const group = binding.primarySource?.group;
        const direct = binding.primarySource?.directEntry;
        let reference = direct?.compositeKey ?? group?.resolvedEntryId ?? '';
        if (!reference && direct?.modelEntryId) {
          const entry = sourceRecords['ProviderModelEntryV3:' + direct.modelEntryId]?.record;
          if (entry) {
            const base = JSON.parse(replicaText(entry, 'baseModelJson')) as Record<string, Object>;
            reference = replicaText(entry, 'providerInstanceId') + '/' + `${base['id'] ?? ''}`;
          }
        }
        if (group) {
          const queue = providerStore.queue(session.id, group.groupId, false);
          const index = queue.findIndex((slot: FailoverSlot) => slot.instanceId + '/' + slot.model === reference);
          if (index >= 0) { session.modelQueue = queue.slice(index).concat(queue.slice(0, index)); session.modelGroupId = group.groupId; resolved = true; }
        } else if (reference) {
          const candidate = providerStore.instances.find((row: ProviderInstance) => row.enabled && reference.startsWith(row.id + '/'));
          if (candidate) { const slot = new FailoverSlot(); slot.instanceId = candidate.id; slot.model = reference.substring(candidate.id.length + 1); session.modelQueue = [slot]; session.modelGroupId = ''; resolved = true; }
        }
      } else {
        const candidates = providerStore.instances.filter((row: ProviderInstance) => row.enabled && (row.model === model || row.models.indexOf(model) >= 0));
        if (model && candidates.length === 1) { const slot = new FailoverSlot(); slot.instanceId = candidates[0].id; slot.model = model; session.modelQueue = [slot]; resolved = true; }
      }
      if (resolved) session.unresolvedModelId = '';
      else if (model || rawBinding) { session.modelQueue = []; session.unresolvedModelId = model || '原会话模型'; }

    } else {
      if (!record) return false;
      if (!session.id) { session.id = id; session.title = '同步对话'; }
      const role = replicaText(record, 'role');
      if (role !== 'user' && role !== 'assistant' && role !== 'system') return false;
      const parts = JSON.parse(replicaText(record, 'partsJson') || '[]') as TextPart[];
      if (!Array.isArray(parts)) return false;
      let text = parts.filter((part: TextPart) => part && part.type === 'text' && typeof part.value === 'string').map((part: TextPart) => part.value).join('\n');
      if (!text && parts.some((part: TextPart) => part.type === 'mediaRef')) text = '[附件]';
      if (!text && parts.some((part: TextPart) => part.type === 'toolUse' || part.type === 'toolResult')) text = '[工具步骤]';
      if (!text) return false;
      const existing = session.messages.find((item: LocalChatMessage) => item.syncId === change.id.id);
      if (!force && existing && existing.text !== text && replicaDate(session.updatedAt) > change.updatedAt) return false;
      const line = session.messages.find((item: LocalChatMessage) => item.syncId === change.id.id) ?? new LocalChatMessage();
      line.syncId = change.id.id; line.text = text; line.role = role;
      line.syncPartsJson = replicaText(record, 'partsJson'); line.syncText = text;
      const date = record.fields['createdAt'];
      line.at = date && date.t === 'date' && typeof date.v === 'number' ? Number(date.v) * 1000 + APPLE_EPOCH_MS : Date.now();
      if (record.unknownFields['harmonyKind']) line.kind = `${record.unknownFields['harmonyKind'].v ?? ''}`;
      if (!session.messages.some((item: LocalChatMessage) => item.syncId === line.syncId)) session.messages.push(line);
      session.messages.sort((a: LocalChatMessage, b: LocalChatMessage) => a.at - b.at || a.syncId.localeCompare(b.syncId));
    }
    session.updatedAt = Math.max(session.updatedAt, change.updatedAt * 1000 + APPLE_EPOCH_MS);
    if (!fileIo.accessSync(`${context.filesDir}/sessions`)) fileIo.mkdirSync(`${context.filesDir}/sessions`);
    ChatRuns.invalidateIdle(id);
    atomicWriteText(path, JSON.stringify(session)); await sessionStore.reload(context); return !session.unresolvedModelId;
  }

  static async deleteMessage(context: common.Context, messageId: string, prior: ReplicaRecord): Promise<boolean> {
    const sessionId = replicaText(prior, 'sessionId');
    if (!SessionStore.validId(sessionId)) return false;
    const session = await sessionStore.get(context, sessionId); if (!session || session.running) return false;
    ChatRuns.invalidateIdle(sessionId);
    session.messages = session.messages.filter((line: LocalChatMessage) => line.syncId !== messageId);
    atomicWriteText(`${context.filesDir}/sessions/${sessionId}.json`, JSON.stringify(session));
    await sessionStore.reload(context); return true;
  }

  static async localFingerprint(context: common.Context, record: ReplicaRecord): Promise<string> {
    const sessionId = record.id.type === 'SessionV2' ? record.id.id : replicaText(record, 'sessionId');
    if (!SessionStore.validId(sessionId)) return '';
    const session = await sessionStore.get(context, sessionId); if (!session) return '';
    if (record.id.type === 'SessionV2') {
      const bound = session.modelQueue[0];
      const reference = bound ? (session.modelGroupId ? session.modelGroupId + '|' : '') + bound.instanceId + '/' + bound.model : SessionReplica.bindingIdentity(record, context);
      const model = session.unresolvedModelId ? replicaText(record, 'modelId') : (bound?.model ?? '');
      return JSON.stringify([session.title, model, reference, session.memoryEnabled !== false, session.pinned === true]);
    }
    const line = session.messages.find((item: LocalChatMessage) => item.syncId === record.id.id); if (!line) return '';
    const part = new TextPart(); part.value = line.text;
    const parts = line.syncText === line.text && line.syncPartsJson ? line.syncPartsJson : JSON.stringify([part]);
    return JSON.stringify([sessionId, line.role, parts]);
  }

  static fingerprint(record: ReplicaRecord, context: common.Context | null = null): string {
    if (record.id.type === 'SessionV2') return JSON.stringify([replicaText(record, 'title'), replicaText(record, 'modelId'), SessionReplica.bindingIdentity(record, context), Number(record.fields['memoryEnabled']?.v ?? 1) !== 0, record.fields['pinnedAt']?.t === 'date']);
    return JSON.stringify([replicaText(record, 'sessionId'), replicaText(record, 'role'), replicaText(record, 'partsJson')]);
  }

  private static bindingIdentity(record: ReplicaRecord, context: common.Context | null): string {
    const raw = replicaText(record, 'modelBinding'); if (!raw) return '';
    const binding = JSON.parse(raw) as ModelBinding; const group = binding.primarySource?.group; const direct = binding.primarySource?.directEntry;
    let reference = group?.resolvedEntryId ?? direct?.compositeKey ?? direct?.modelEntryId ?? '';
    if (context && reference.indexOf('/') < 0) {
      const path = context.filesDir + '/sync-config-ids.json';
      const ids: Record<string, string> = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
      reference = Object.keys(ids).find((key: string) => ids[key] === reference && !key.startsWith('env:')) ?? reference;
    }
    return group ? group.groupId + '|' + reference : reference;
  }

  private static dateField(milliseconds: number): PortableValue {
    const field = new PortableValue(); field.t = 'date'; field.v = replicaDate(milliseconds); return field;
  }
}
