import { McpOAuth } from '../local/McpOAuth';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { ProviderInstance, ModelGroup, providerStore } from '../store/ProviderStore';
import { McpServer, mcpStore } from '../store/McpStore';
import { EnvEntry, envStore } from '../store/EnvStore';
import { atomicWriteText } from '../store/AtomicFile';
import { ReplicaChange, ReplicaRecord, PortableValue, replicaDate, replicaText, textValue, recordKey } from './SyncProtocol';

class ModelBase { id: string = ''; displayName: string = ''; provider: string = ''; }
class GroupIntents { added: Record<string, number> = {}; removed: Record<string, number> = {}; }
class MCPEntry { url?: string; command?: string; args?: string[]; env?: Record<string, string>; oauth?: Record<string, Object>; enabled: boolean = true; headers?: Record<string, string>; }
const TYPES: string[] = ['ProviderInstanceV3', 'ProviderModelEntryV3', 'ProviderModelGroupV3', 'ProviderConfigV2', 'MCPServersV2', 'MCPServerItem', 'EnvVarV2', 'EnvVarItem'];

export class ConfigReplica {
  static supported(type: string): boolean { return TYPES.indexOf(type) >= 0; }

  static async apply(context: common.Context, change: ReplicaChange, records: Record<string, ReplicaChange>, keepLocalMetadata: boolean = false): Promise<boolean> {
    const type = change.id.type; if (!ConfigReplica.supported(type)) return false;
    await Promise.all([providerStore.ensureLoaded(context), mcpStore.load(context), envStore.load(context)]);
    const record = change.record;
    if (change.operation === 'delete') {
      if (type === 'ProviderInstanceV3') await providerStore.remove(context, change.id.id);
      else if (type === 'ProviderModelGroupV3') await providerStore.removeGroup(context, change.id.id);
      else if (type === 'MCPServerItem') await mcpStore.remove(context, change.id.id);
      else if (type === 'EnvVarItem') {
        const previous = change.record ?? records[recordKey(change.id)]?.record;
        if (previous) await envStore.remove(context, replicaText(previous, 'key'));
      } else if (type === 'ProviderModelEntryV3') {
        const previous = change.record ?? records[recordKey(change.id)]?.record;
        if (previous) await ConfigReplica.removeModel(context, previous);
      }
      return true;
    }
    if (!record) return false;
    if (type === 'ProviderInstanceV3') {
      const old = providerStore.instances.find((row: ProviderInstance) => row.id === change.id.id);
      const row = old ? JSON.parse(JSON.stringify(old)) as ProviderInstance : new ProviderInstance();
      row.id = change.id.id; row.label = replicaText(record, 'label'); row.type = replicaText(record, 'providerType') || 'custom';
      row.credential = replicaText(record, 'credentialType') || 'apiKey'; row.baseUrl = replicaText(record, 'customBaseURL');
      row.enabled = ConfigReplica.number(record, 'isEnabled', 1) !== 0; row.appendV1 = ConfigReplica.number(record, 'appendV1Suffix', 1) !== 0;
      row.azureMode = ConfigReplica.number(record, 'azureMode', 0) !== 0;
      // 凭据不从同步正文解码；同源旧凭据由 ProviderStore 自己保留，变更目标会解除旧绑定。
      await providerStore.upsert(context, row, '', old ? JSON.stringify(old) : '', false);
      const disabled = ConfigReplica.disabledDestinations(context);
      if (row.enabled && disabled[row.id] === ConfigReplica.destination(row)) {
        const next: Record<string, string> = {}; const names = Object.keys(disabled);
        for (let i = 0; i < names.length; i++) if (names[i] !== row.id) next[names[i]] = disabled[names[i]];
        atomicWriteText(context.filesDir + '/sync-disabled-destinations.json', JSON.stringify(next));
      }
      return true;
    }
    if (type === 'ProviderModelEntryV3') {
      const id = replicaText(record, 'providerInstanceId'); const row = providerStore.instances.find((item: ProviderInstance) => item.id === id);
      const model = JSON.parse(replicaText(record, 'baseModelJson') || '{}') as ModelBase;
      if (!row || !model.id) return false;
      const copy = JSON.parse(JSON.stringify(row)) as ProviderInstance;
      copy.modelMetadata[model.id] = replicaText(record, 'baseModelJson');
      const intent = record.fields['userModifiedAt'];
      const remoteEdit = intent && intent.t === 'date' && typeof intent.v === 'number' ? Number(intent.v) * 1000 + 978307200000 : 0;
      const localEdit = copy.visibilityEditedAt[model.id] ?? 0;
      if (remoteEdit >= localEdit) {
        const hidden = ConfigReplica.number(record, 'isHidden', 0) === 1;
        copy.hiddenModels = copy.hiddenModels.filter((entry: string) => entry !== model.id);
        if (hidden) copy.hiddenModels.push(model.id);
        copy.modelOverrides[model.id] = replicaText(record, 'overridesJson') || '{}';
        if (remoteEdit > 0) copy.visibilityEditedAt[model.id] = remoteEdit;
        if (remoteEdit > 0) copy.deletedModels = copy.deletedModels.filter((entry: string) => entry !== model.id);
      }
      if (copy.deletedModels.indexOf(model.id) < 0 && copy.models.indexOf(model.id) < 0) copy.models.push(model.id);
      if (!copy.model) copy.model = model.id;
      await providerStore.upsert(context, copy, '', JSON.stringify(row));
      const path = context.filesDir + '/sync-config-ids.json';
      const ids: Record<string, string> = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
      ids[id + '/' + model.id] = change.id.id; atomicWriteText(path, JSON.stringify(ids));
      return true;
    }
    if (type === 'ProviderModelGroupV3') {
      const group = new ModelGroup(); group.id = change.id.id; group.name = replicaText(record, 'name');
      group.strategy = replicaText(record, 'strategy') || 'fallback'; group.fallbackStrategy = replicaText(record, 'fallbackStrategy') || 'limited';
      group.defaultThinkingLevel = replicaText(record, 'defaultThinkingLevel');
      const ids = JSON.parse(replicaText(record, 'memberEntryIdsJson') || '[]') as string[];
      const intent = JSON.parse(replicaText(record, 'removedMembersJson') || '{}') as Record<string, Object>;
      const removed = (intent['removed'] ?? {}) as Record<string, number>;
      const added = (intent['added'] ?? {}) as Record<string, number>;
      if (!Array.isArray(ids)) throw new Error('同步模型组成员格式无效');
      const references = ids.concat(Object.keys(added)).concat(Object.keys(removed)).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
      for (let i = 0; i < references.length; i++) {
        const rawId = references[i];
        const entry = ConfigReplica.modelReference(rawId, records, context);
        if (!entry) continue;
        group.removedMembers[entry] = removed[rawId] ?? 0; group.addedMembers[entry] = added[rawId] ?? 0;
        if (ids.indexOf(rawId) >= 0 && group.addedMembers[entry] >= group.removedMembers[entry]) group.modelIds.push(entry);
      }
      if (ids.length > 0 && group.modelIds.length + Object.keys(group.removedMembers).filter((id: string) => group.removedMembers[id] > 0).length < ids.length) return false;
      const local = providerStore.groups.find((item: ModelGroup) => item.id === group.id);
      if (keepLocalMetadata && local) { group.name = local.name; group.strategy = local.strategy; group.fallbackStrategy = local.fallbackStrategy; group.defaultThinkingLevel = local.defaultThinkingLevel; }
      await providerStore.mergeReplicaGroup(context, group); return true;
    }
    if (type === 'MCPServerItem') return await ConfigReplica.applyMCP(context, change.id.id, replicaText(record, 'entryJson'));
    if (type === 'MCPServersV2') {
      const body = JSON.parse(replicaText(record, 'serversJson') || '{}') as Record<string, Object>;
      const rows = (body['mcpServers'] ?? body) as Record<string, Object>; const names = Object.keys(rows);
      for (let i = 0; i < names.length; i++) {
        const entry = rows[names[i]] as Record<string, Object>;
        const modified = typeof entry['updatedAt'] === 'number' ? replicaDate(Number(entry['updatedAt']) * 1000) : record.updatedAt;
        if (await ConfigReplica.acceptLegacy(context, records, 'MCPServerItem', names[i], modified)) await ConfigReplica.applyMCP(context, names[i], JSON.stringify(entry));
      }
      return true;
    }
    if (type === 'EnvVarItem') {
      const key = replicaText(record, 'key'); if (!key) return false;
      await envStore.mergeReplicaName(context, key);
      const path = context.filesDir + '/sync-config-ids.json';
      const ids: Record<string, string> = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
      ids['env:' + key] = change.id.id; atomicWriteText(path, JSON.stringify(ids)); return true;
    }
    if (type === 'EnvVarV2') {
      const rows = JSON.parse(replicaText(record, 'envVarsJson') || '[]') as Record<string, Object>[];
      if (!Array.isArray(rows)) return false;
      for (const source of rows) {
        const key = `${source['key'] ?? ''}`; const id = `${source['id'] ?? ''}`; if (!key || !id) continue;
        if (!await ConfigReplica.acceptLegacy(context, records, 'EnvVarItem', id, record.updatedAt)) continue;
        const item = new ReplicaChange(); item.id.type = 'EnvVarItem'; item.id.id = id; item.record = new ReplicaRecord(); item.record.id = item.id;
        item.record.fields['key'] = textValue(key); await ConfigReplica.apply(context, item, records);
      }
      return true;
    }
    // Latest iOS makes V3 authoritative. Retaining a V2 snapshot must never resurrect its deleted providers.
    if (type === 'ProviderConfigV2') return true;
    return false;
  }

  static async capture(context: common.Context, records: Record<string, ReplicaChange>): Promise<ReplicaRecord[]> {
    await Promise.all([providerStore.ensureLoaded(context), mcpStore.load(context), envStore.load(context)]);
    const output: ReplicaRecord[] = [];
    const idsPath = context.filesDir + '/sync-config-ids.json';
    const ids: Record<string, string> = fileIo.accessSync(idsPath) ? JSON.parse(fileIo.readTextSync(idsPath)) as Record<string, string> : {};
    const now = replicaDate(Date.now());
    for (let i = 0; i < providerStore.instances.length; i++) {
      const row = providerStore.instances[i]; const record = ConfigReplica.record('ProviderInstanceV3', row.id, now);
      record.fields['label'] = textValue(row.label); record.fields['providerType'] = textValue(row.type);
      record.fields['credentialType'] = textValue(row.credential); record.fields['customBaseURL'] = textValue(row.baseUrl);
      record.fields['appendV1Suffix'] = ConfigReplica.integer(row.appendV1 ? 1 : 0); record.fields['azureMode'] = ConfigReplica.integer(row.azureMode ? 1 : 0);
      record.fields['isEnabled'] = ConfigReplica.integer(row.enabled ? 1 : 0); record.fields['sortOrder'] = ConfigReplica.integer(i);
      record.fields['createdAt'] = ConfigReplica.date(row.createdAt || Date.now());
      const prior = records['ProviderInstanceV3:' + row.id]?.record;
      if (prior && replicaText(prior, 'secretBlob') &&
        (replicaText(prior, 'providerType') !== row.type || replicaText(prior, 'credentialType') !== row.credential || replicaText(prior, 'customBaseURL') !== row.baseUrl || ConfigReplica.number(prior, 'appendV1Suffix', 1) !== (row.appendV1 ? 1 : 0) || ConfigReplica.number(prior, 'azureMode', 0) !== (row.azureMode ? 1 : 0))) {
        // 同步目标改变后撤销旧凭据，接收端需显式重新启用并绑定密钥。
        const empty = new PortableValue(); empty.t = 'null';
        record.fields['secretBlob'] = empty; record.fields['secretKind'] = empty; record.fields['secretUpdatedAt'] = ConfigReplica.date(Date.now());
        record.fields['isEnabled'] = ConfigReplica.integer(0);
        const disabled = ConfigReplica.disabledDestinations(context); disabled[row.id] = ConfigReplica.destination(row);
        atomicWriteText(context.filesDir + '/sync-disabled-destinations.json', JSON.stringify(disabled));
      }
      if (ConfigReplica.disabledDestinations(context)[row.id] === ConfigReplica.destination(row)) record.fields['isEnabled'] = ConfigReplica.integer(0);
      output.push(record);
      for (let j = 0; j < row.models.length; j++) {
        const model = row.models[j]; const key = row.id + '/' + model;
        if (!ids[key]) ids[key] = util.generateRandomUUID();
        const entry = ConfigReplica.record('ProviderModelEntryV3', ids[key], now);
        const base = new ModelBase(); base.id = model; base.displayName = model; base.provider = row.type;
        const previous = records['ProviderModelEntryV3:' + ids[key]]?.record;
        entry.fields['providerInstanceId'] = textValue(row.id); entry.fields['baseModelJson'] = row.modelMetadata[model] ? textValue(row.modelMetadata[model]) : (previous ? previous.fields['baseModelJson'] : textValue(JSON.stringify(base)));
        if (row.modelOverrides[model]) entry.fields['overridesJson'] = textValue(row.modelOverrides[model]);
        entry.fields['isCustom'] = ConfigReplica.integer(row.discoveredModels.indexOf(model) < 0 ? 1 : 0);
        entry.fields['isHidden'] = ConfigReplica.integer(row.hiddenModels.indexOf(model) >= 0 ? 1 : 0); entry.fields['sortOrder'] = ConfigReplica.integer(j);
        if (row.visibilityEditedAt[model]) entry.fields['userModifiedAt'] = ConfigReplica.date(row.visibilityEditedAt[model]);
        output.push(entry);
      }
    }
    for (let i = 0; i < providerStore.groups.length; i++) {
      const group = providerStore.groups[i]; const record = ConfigReplica.record('ProviderModelGroupV3', group.id, now);
      record.fields['name'] = textValue(group.name); record.fields['strategy'] = textValue(group.strategy);
      record.fields['fallbackStrategy'] = textValue(group.fallbackStrategy); record.fields['defaultThinkingLevel'] = textValue(group.defaultThinkingLevel);
      record.fields['memberEntryIdsJson'] = textValue(JSON.stringify(group.modelIds.map((id: string) => ids[id] ?? id)));
      const removed: Record<string, number> = {}; const added: Record<string, number> = {};
      const removedKeys = Object.keys(group.removedMembers); const addedKeys = Object.keys(group.addedMembers);
      for (let j = 0; j < removedKeys.length; j++) removed[ids[removedKeys[j]] ?? removedKeys[j]] = group.removedMembers[removedKeys[j]];
      for (let j = 0; j < addedKeys.length; j++) added[ids[addedKeys[j]] ?? addedKeys[j]] = group.addedMembers[addedKeys[j]];
      const intent = new GroupIntents(); intent.added = added; intent.removed = removed;
      record.fields['removedMembersJson'] = textValue(JSON.stringify(intent)); record.fields['sortOrder'] = ConfigReplica.integer(i); output.push(record);
    }
    for (let i = 0; i < mcpStore.rows.length; i++) {
      const row = mcpStore.rows[i]; const record = ConfigReplica.record('MCPServerItem', row.label, now);
      const prior = records['MCPServerItem:' + row.label]?.record;
      const entry = prior ? JSON.parse(replicaText(prior, 'entryJson') || '{}') as MCPEntry : new MCPEntry();
      if (row.transport === 'stdio') {
        const same = entry.command === row.command && JSON.stringify(entry.args ?? []) === JSON.stringify(row.args);
        const environment: Record<string, string> = {};
        const names = Object.keys(row.env);
        for (let j = 0; j < names.length; j++) environment[names[j]] = same ? (entry.env?.[names[j]] ?? '') : '';
        entry.url = undefined; entry.headers = undefined; entry.oauth = undefined; entry.command = row.command; entry.args = row.args.slice(); entry.env = environment;
      } else {
        const sameURL = entry.url === row.url;
        const headers: Record<string, string> = {}; const names = Object.keys(row.headers);
        for (let j = 0; j < names.length; j++) headers[names[j]] = sameURL ? (entry.headers?.[names[j]] ?? '') : '';
        if (!sameURL) entry.oauth = undefined; entry.headers = headers;
        entry.url = row.url; entry.command = undefined; entry.args = undefined; entry.env = undefined;
        const oauth = McpOAuth.exportPublicMetadata(row.label, row.url); if (oauth) entry.oauth = oauth;
      }
      entry.enabled = row.enabled;
      record.fields['serverName'] = textValue(row.label); record.fields['entryJson'] = textValue(JSON.stringify(entry));
      record.fields['createdAt'] = ConfigReplica.date(Date.now()); output.push(record);
    }
    for (let i = 0; i < envStore.rows.length; i++) {
      const row = envStore.rows[i]; const key = 'env:' + row.name; if (!ids[key]) ids[key] = util.generateRandomUUID();
      const record = ConfigReplica.record('EnvVarItem', ids[key], now);
      record.fields['entryId'] = textValue(ids[key]); record.fields['key'] = textValue(row.name); record.fields['note'] = textValue('');
      // 空值表示本端没有共享密钥；本机 AssetStore 值不会进入同步。
      const prior = records['EnvVarItem:' + ids[key]]?.record;
      record.fields['valueB64'] = prior?.fields['valueB64'] ?? textValue(''); record.fields['createdAt'] = ConfigReplica.date(Date.now()); output.push(record);
    }
    atomicWriteText(idsPath, JSON.stringify(ids)); return output;
  }

  static async localFingerprint(context: common.Context, record: ReplicaRecord): Promise<string> {
    await Promise.all([providerStore.ensureLoaded(context), mcpStore.load(context), envStore.load(context)]);
    if (record.id.type === 'ProviderInstanceV3') {
      const row = providerStore.instances.find((item: ProviderInstance) => item.id === record.id.id); if (!row) return '';
      return JSON.stringify([row.label, row.type, row.credential || 'apiKey', row.baseUrl, row.appendV1 ? 1 : 0, ConfigReplica.disabledDestinations(context)[row.id] === ConfigReplica.destination(row) ? 0 : (row.enabled ? 1 : 0), row.azureMode ? 1 : 0]);
    }
    if (record.id.type === 'ProviderModelEntryV3') {
      const id = replicaText(record, 'providerInstanceId'); const base = JSON.parse(replicaText(record, 'baseModelJson') || '{}') as ModelBase;
      const row = providerStore.instances.find((item: ProviderInstance) => item.id === id); if (!row || row.models.indexOf(base.id) < 0) return '';
      return JSON.stringify([id, base.id, row.hiddenModels.indexOf(base.id) >= 0 ? 1 : 0]);
    }
    if (record.id.type === 'ProviderModelGroupV3') {
      const group = providerStore.groups.find((row: ModelGroup) => row.id === record.id.id); if (!group) return '';
      const path = context.filesDir + '/sync-config-ids.json';
      const ids: Record<string, string> = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
      const current = new ReplicaRecord(); current.id = record.id;
      current.fields['name'] = textValue(group.name); current.fields['strategy'] = textValue(group.strategy);
      current.fields['fallbackStrategy'] = textValue(group.fallbackStrategy); current.fields['defaultThinkingLevel'] = textValue(group.defaultThinkingLevel);
      current.fields['memberEntryIdsJson'] = textValue(JSON.stringify(group.modelIds.map((id: string) => ids[id] ?? id)));
      const intent = new GroupIntents();
      const added = Object.keys(group.addedMembers); const removed = Object.keys(group.removedMembers);
      for (let i = 0; i < added.length; i++) intent.added[ids[added[i]] ?? added[i]] = group.addedMembers[added[i]];
      for (let i = 0; i < removed.length; i++) intent.removed[ids[removed[i]] ?? removed[i]] = group.removedMembers[removed[i]];
      current.fields['removedMembersJson'] = textValue(JSON.stringify(intent)); return ConfigReplica.fingerprint(current);
    }
    if (record.id.type === 'MCPServerItem') {
      const row = mcpStore.rows.find((item: McpServer) => item.label === record.id.id); return row ? (row.transport === 'stdio' ? JSON.stringify(['stdio', row.command, row.args, Object.keys(row.env).sort(), row.enabled]) : JSON.stringify(['http', row.url, row.enabled, Object.keys(row.headers).map((key: string) => key.toLowerCase()).sort(), ConfigReplica.oauthFingerprint(McpOAuth.exportPublicMetadata(row.label, row.url))])) : '';
    }
    if (record.id.type === 'EnvVarItem') return envStore.rows.some((row: EnvEntry) => row.name === replicaText(record, 'key')) ? JSON.stringify([replicaText(record, 'key')]) : '';
    return '';
  }

  static fingerprint(record: ReplicaRecord): string {
    if (record.id.type === 'ProviderInstanceV3') return JSON.stringify([
      replicaText(record, 'label'), replicaText(record, 'providerType'), replicaText(record, 'credentialType') || 'apiKey',
      replicaText(record, 'customBaseURL'), ConfigReplica.number(record, 'appendV1Suffix', 1), ConfigReplica.number(record, 'isEnabled', 1), ConfigReplica.number(record, 'azureMode', 0)]);
    if (record.id.type === 'ProviderModelEntryV3') {
      const base = JSON.parse(replicaText(record, 'baseModelJson') || '{}') as ModelBase;
      return JSON.stringify([replicaText(record, 'providerInstanceId'), base.id, ConfigReplica.number(record, 'isHidden', 0)]);
    }
    if (record.id.type === 'ProviderModelGroupV3') return JSON.stringify([
      replicaText(record, 'name'), replicaText(record, 'strategy') || 'fallback', replicaText(record, 'fallbackStrategy') || 'limited',
      replicaText(record, 'defaultThinkingLevel'), JSON.parse(replicaText(record, 'memberEntryIdsJson') || '[]'),
      ConfigReplica.intentFingerprint(replicaText(record, 'removedMembersJson'))]);
    if (record.id.type === 'MCPServerItem') {
      const entry = JSON.parse(replicaText(record, 'entryJson') || '{}') as MCPEntry;
      const environment: Record<string, string> = entry.env ?? {}; const headers: Record<string, string> = entry.headers ?? {};
      return entry.command && !entry.url ? JSON.stringify(['stdio', entry.command, entry.args ?? [], Object.keys(environment).sort(), entry.enabled !== false]) : JSON.stringify(['http', entry.url || '', entry.enabled !== false, Object.keys(headers).map((key: string) => key.toLowerCase()).sort(), ConfigReplica.oauthFingerprint(entry.oauth ?? null)]);
    }
    if (record.id.type === 'EnvVarItem') return JSON.stringify([replicaText(record, 'key')]);
    const names = Object.keys(record.fields).filter((key: string) => key !== 'createdAt' && key !== 'updatedAt' && key !== 'sortOrder').sort();
    return JSON.stringify(names.map((key: string) => [key, record.fields[key]]));
  }

  private static async acceptLegacy(context: common.Context, records: Record<string, ReplicaChange>, type: string, id: string, updatedAt: number): Promise<boolean> {
    const modern = records[type + ':' + id];
    if (modern && modern.updatedAt >= updatedAt) return false;
    if (modern?.record) {
      const local = await ConfigReplica.localFingerprint(context, modern.record);
      if (local && local !== ConfigReplica.fingerprint(modern.record)) return false;
    }
    return true;
  }

  private static oauthFingerprint(fields: Record<string, Object> | null): string {
    if (!fields) return '';
    return JSON.stringify([fields['mode'] ?? 'static', fields['clientId'] ?? '', fields['authorizationEndpoint'] ?? '', fields['tokenEndpoint'] ?? '', fields['scopes'] ?? '', fields['redirectURI'] ?? '']);
  }

  private static disabledDestinations(context: common.Context): Record<string, string> {
    const path = context.filesDir + '/sync-disabled-destinations.json'; return fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
  }
  private static destination(row: ProviderInstance): string { return JSON.stringify([row.type, row.credential, row.baseUrl, row.appendV1, row.azureMode]); }

  static localUpdatedAt(context: common.Context, type: string): number {
    const name = type.startsWith('MCP') ? 'mcp.json' : (type.startsWith('Env') ? 'env.json' : 'providers.json');
    const path = context.filesDir + '/' + name; return fileIo.accessSync(path) ? replicaDate(fileIo.statSync(path).mtime * 1000) : 0;
  }

  private static intentFingerprint(raw: string): string {
    const body = JSON.parse(raw || '{}') as Record<string, Object>;
    const added = (body['added'] ?? {}) as Record<string, number>; const removed = (body['removed'] ?? {}) as Record<string, number>;
    return JSON.stringify([Object.keys(added).sort().map((key: string) => [key, added[key]]), Object.keys(removed).sort().map((key: string) => [key, removed[key]])]);
  }

  private static modelReference(id: string, records: Record<string, ReplicaChange>, context: common.Context): string {
    const record = records['ProviderModelEntryV3:' + id]?.record;
    if (record) { const base = JSON.parse(replicaText(record, 'baseModelJson') || '{}') as ModelBase; return replicaText(record, 'providerInstanceId') + '/' + base.id; }
    const path = context.filesDir + '/sync-config-ids.json';
    const ids: Record<string, string> = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, string> : {};
    const key = Object.keys(ids).find((key: string) => ids[key] === id && !key.startsWith('env:'));
    return key ?? (id.indexOf('/') > 0 ? id : '');
  }

  private static async removeModel(context: common.Context, record: ReplicaRecord): Promise<void> {
    const instance = replicaText(record, 'providerInstanceId'); const row = providerStore.instances.find((item: ProviderInstance) => item.id === instance);
    const base = JSON.parse(replicaText(record, 'baseModelJson') || '{}') as ModelBase;
    if (!row || !base.id) return;
    const copy = JSON.parse(JSON.stringify(row)) as ProviderInstance;
    copy.models = copy.models.filter((id: string) => id !== base.id);
    copy.hiddenModels = copy.hiddenModels.filter((id: string) => id !== base.id);
    if (copy.deletedModels.indexOf(base.id) < 0) copy.deletedModels.push(base.id);
    await providerStore.upsert(context, copy, '', JSON.stringify(row));
  }

  private static async applyMCP(context: common.Context, id: string, raw: string): Promise<boolean> {
    const entry = JSON.parse(raw || '{}') as MCPEntry;
    const environment: Record<string, string> = entry.env ?? {}; const headers: Record<string, string> = entry.headers ?? {};
    if (entry.command && !entry.url) {
      if (entry.args !== undefined && !Array.isArray(entry.args)) throw new Error('MCP参数格式无效');
      await mcpStore.mergeStdioReplicaMetadata(context, id, entry.command, entry.args ?? [], Object.keys(environment), entry.enabled !== false); return true;
    }
    if (!entry.url) return false;
    await mcpStore.mergeHTTPPublicMetadata(context, id, entry.url, Object.keys(headers), entry.enabled !== false);
    if (entry.oauth) await McpOAuth.mergePublicMetadata(context, id, entry.url, entry.oauth); return true;
  }
  private static record(type: string, id: string, updatedAt: number): ReplicaRecord {
    const record = new ReplicaRecord(); record.id.type = type; record.id.id = id; record.updatedAt = updatedAt;
    record.fields['updatedAt'] = ConfigReplica.date(updatedAt * 1000 + 978307200000); return record;
  }
  private static integer(value: number): PortableValue { const field = new PortableValue(); field.t = 'int'; field.v = value; return field; }
  private static date(milliseconds: number): PortableValue { const field = new PortableValue(); field.t = 'date'; field.v = replicaDate(milliseconds); return field; }
  private static number(record: ReplicaRecord, key: string, fallback: number): number { const field = record.fields[key]; return field && typeof field.v === 'number' ? Number(field.v) : fallback; }
}
