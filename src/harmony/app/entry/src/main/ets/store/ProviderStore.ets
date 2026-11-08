import { BoundSecret } from './BoundSecret';
import { AtomicTextFile } from './AtomicFile';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { kindByKey, providerKinds } from '../local/ProviderCatalog';
import { FailoverSlot, ProviderSlot, requireProviderRoot, resolveFailoverQueue, stableModelIndex } from '../local/LocalProtocol';
import {
  chatModelsFor,
  idsFromModelsDevJson,
  MODELS_DEV_URL,
  modelIdsFromListJson,
  modelsAuthHeaders,
  modelsDevProviderKey,
  modelMetadataFromList,
  modelsListUrl,
  skipUpstreamModels
} from '../local/ProviderModels';
import { OAUTH_ALIAS, SecretStore } from './SecretStore';

const FILE_NAME = 'providers.json';
const OLD_FILE = 'provider.json';

export class ProviderInstance {
  id: string = '';
  secretRef: string = '';
  label: string = '';
  type: string = 'openAI';
  baseUrl: string = '';
  model: string = '';
  models: string[] = [];
  discoveredModels: string[] = [];
  deletedModels: string[] = [];
  hiddenModels: string[] = [];
  modelMetadata: Record<string, string> = {};
  modelOverrides: Record<string, string> = {};
  visibilityEditedAt: Record<string, number> = {};
  enabled: boolean = true;
  appendV1: boolean = true;
  azureMode: boolean = false;
  credential: string = 'apiKey';
  createdAt: number = 0;
}

export class ProviderRunSlot {
  fallbackAlways: boolean = false;
  instanceId: string = '';
  model: string = '';
  root: string = '';
  key: string = '';
  type: string = '';
  credential: string = '';
  reference: string = '';
  metadata: string = '';
}

export class ModelGroup {
  id: string = '';
  name: string = '';
  modelIds: string[] = [];
  strategy: string = 'fallback';
  fallbackStrategy: string = 'limited';
  defaultThinkingLevel: string = '';
  removedMembers: Record<string, number> = {};
  addedMembers: Record<string, number> = {};
}

class ProviderFile {
  activeId: string = '';
  activeGroupId: string = '';
  instances: ProviderInstance[] = [];
  groups: ModelGroup[] = [];
}

export class ProviderStore {
  private readonly configFile: AtomicTextFile = new AtomicTextFile();
  instances: ProviderInstance[] = [];
  groups: ModelGroup[] = [];
  activeId: string = '';
  activeGroupId: string = '';
  apiKey: string = '';
  jsonLoadFailed: boolean = false;
  lastError: string = '';
  private loaded: boolean = false;
  private pending: Promise<void> | null = null;
  private keys: Map<string, string> = new Map();
  private keyBindings: Map<string, string> = new Map();
  private context: common.Context | null = null;
  private writes: Promise<void> = Promise.resolve();

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.writes.then(action);
    this.writes = next.catch(() => {});
    return next;
  }

  credentialReference(id: string): string {
    return this.instances.find((row: ProviderInstance) => row.id === id)?.secretRef ?? '';
  }

  private binding(row: ProviderInstance): string {
    return JSON.stringify(['provider', row.id, row.type, row.credential, this.effectiveRoot(row), row.azureMode]);
  }

  get baseUrl(): string {
    const row = this.active();
    return row ? this.effectiveRoot(row) : '';
  }

  get model(): string {
    const row = this.active();
    return row ? row.model : '';
  }

  configured(): boolean {
    const queue = this.queue('configuration');
    return queue.some((slot: FailoverSlot) => {
      const row = this.instances.find((item: ProviderInstance) => item.id === slot.instanceId);
      return row !== undefined && row.enabled && this.effectiveRoot(row).length > 0 && slot.model.length > 0 && this.keyFor(row.id).length > 0;
    });
  }

  active(): ProviderInstance | null {
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === this.activeId) {
        return this.instances[i];
      }
    }
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].enabled) {
        return this.instances[i];
      }
    }
    return this.instances.length > 0 ? this.instances[0] : null;
  }

  nextLabel(type: string): string {
    const title = kindByKey(type).title;
    const used: string[] = [];
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].type === type) {
        used.push(this.instances[i].label);
      }
    }
    if (used.indexOf(title) < 0) {
      return title;
    }
    let n = 2;
    while (used.indexOf(`${title} ${n}`) >= 0) {
      n += 1;
    }
    return `${title} ${n}`;
  }

  keyFor(id: string): string {
    const row = this.instances.find((item: ProviderInstance) => item.id === id);
    if (!row || this.keyBindings.get(id) !== this.binding(row)) return '';
    return (this.keys.get(id) ?? '').trim();
  }

  /** OAuth 刷新也提交新一代；异步刷新不能更新后来换过配置的实例。 */
  commitRefreshedKey(id: string, expectedRef: string, key: string, oauth: string): Promise<void> {
    return this.serial(async () => {
      const context = this.context;
      const row = this.instances.find((item: ProviderInstance) => item.id === id);
      if (!context || !row || row.secretRef !== expectedRef || row.credential !== 'oauth') {
        throw new Error('AI 服务商已变化，本次刷新没有写入');
      }
      const keys = this.snapshotKeys(); keys.set(id, key);
      const tokens: Map<string, string> = new Map(); tokens.set(id, oauth);
      await this.persistSnapshot(context, this.instances, keys, this.activeId, this.groups, this.activeGroupId, tokens);
    });
  }

  effectiveRoot(row: ProviderInstance): string {
    let root = row.baseUrl.trim().replace(/\/+$/, '');
    if (!root) {
      root = kindByKey(row.type).root;
    }
    if (row.type === 'gemini' && root.indexOf('generativelanguage.googleapis.com') >= 0) {
      return root;
    }
    if (row.appendV1 && root.length > 0 && !root.endsWith('/v1') && !root.endsWith('/openai')) {
      root = `${root}/v1`;
    }
    return root;
  }

  grouped(): Map<string, ProviderInstance[]> {
    const map: Map<string, ProviderInstance[]> = new Map();
    const order = providerKinds();
    for (let i = 0; i < order.length; i++) {
      map.set(order[i].key, []);
    }
    for (let i = 0; i < this.instances.length; i++) {
      const bucket = map.get(this.instances[i].type) ?? map.get('custom');
      if (bucket) {
        bucket.push(this.instances[i]);
      }
    }
    return map;
  }

  ensureLoaded(context: common.Context): Promise<void> {
    if (this.pending) return this.pending;
    if (this.loaded) {
      return Promise.resolve();
    }
    if (!this.pending) {
      this.pending = this.readDisk(context, true).catch((err: Error) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  reload(context: common.Context): Promise<void> {
    return this.serial(async () => {
      if (this.pending) await this.pending.catch(() => {});
      await this.recoverFromDisk(context);
    });
  }

  private async recoverFromDisk(context: common.Context): Promise<void> {
    this.loaded = false; this.pending = null;
    await this.readDisk(context, false);
  }

  load(context: common.Context): Promise<void> { return this.ensureLoaded(context); }

  private async readDisk(context: common.Context, migrate: boolean): Promise<void> {
    this.context = context;
    this.jsonLoadFailed = false; this.lastError = '';
    this.instances = []; this.groups = []; this.activeId = ''; this.activeGroupId = '';
    this.keys.clear(); this.keyBindings.clear();
    try {
      const raw = this.configFile.read(ProviderStore.filePath(context, FILE_NAME));
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, Object>;
        this.activeId = `${obj['activeId'] ?? ''}`;
        this.activeGroupId = `${obj['activeGroupId'] ?? ''}`;
        this.instances = ProviderStore.parseInstances(obj['instances']);
        this.groups = ProviderStore.parseGroups(obj['groups']);
      } else {
        this.readLegacy(context);
      }
      let changed = false;
      for (let i = 0; i < this.instances.length; i++) {
        const row = this.instances[i];
        let key = row.secretRef ? await BoundSecret.read(row.secretRef, this.binding(row)) :
          await SecretStore.readProviderKeyFor(row.id);
        if (!row.secretRef && !key && row.id === 'legacy') key = await SecretStore.readProviderKey();
        if (row.type === 'anthropic' && row.credential === 'oauth') {
          row.credential = 'apiKey'; key = ''; changed = true;
        }
        this.keys.set(row.id, key); this.keyBindings.set(row.id, this.binding(row));
        if (!row.secretRef) changed = true;
      }
      this.loaded = true;
      this.apiKey = this.active() ? this.keyFor(this.active()!.id) : '';
      if (migrate && changed) {
        await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, this.groups, this.activeGroupId);
      }
    } catch (error) {
      this.lastError = `${error}`;
      if (!this.loaded) { this.jsonLoadFailed = true; this.instances = []; this.keys.clear(); this.keyBindings.clear(); }
      this.loaded = false;
      throw error as Error;
    }
  }

  private readLegacy(context: common.Context): void {
    const path = ProviderStore.filePath(context, OLD_FILE);
    if (!fileIo.accessSync(path)) return;
    const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
    const root = `${obj['baseUrl'] ?? ''}`;
    if (!root) return;
    const row = new ProviderInstance();
    row.id = 'legacy'; row.label = '本机 AI 服务商'; row.type = 'custom'; row.baseUrl = root;
    row.model = `${obj['model'] ?? 'gpt-4o-mini'}`; row.models = [row.model]; row.createdAt = Date.now();
    this.instances = [row]; this.activeId = row.id;
  }

  private snapshotKeys(): Map<string, string> {
    const keys: Map<string, string> = new Map();
    for (let i = 0; i < this.instances.length; i++) keys.set(this.instances[i].id, this.keyFor(this.instances[i].id));
    return keys;
  }

  private async persistSnapshot(context: common.Context, rows: ProviderInstance[], keys: Map<string, string>,
    activeId: string, groups: ModelGroup[], activeGroupId: string,
    oauthUpdates: Map<string, string> = new Map()): Promise<void> {
    this.assertWritable();
    const previous = this.instances;
    const next = ProviderStore.parseInstances(JSON.parse(JSON.stringify(rows)) as Object[]);
    try {
      for (let i = 0; i < next.length; i++) {
        const row = next[i];
        const old = previous.find((item: ProviderInstance) => item.id === row.id);
        row.secretRef = await BoundSecret.stage(this.binding(row), keys.get(row.id) ?? '');
        if (row.credential === 'oauth') {
          const oauth = oauthUpdates.get(row.id) ?? (old && this.binding(old) === this.binding(row) ?
            await SecretStore.read(`${OAUTH_ALIAS}.${old.secretRef || old.id}`) : '');
          if (oauth) await SecretStore.write(`${OAUTH_ALIAS}.${row.secretRef}`, oauth);
        }
      }
      const body = new ProviderFile(); body.instances = next; body.groups = groups;
      body.activeId = activeId; body.activeGroupId = activeGroupId;
      this.configFile.write(ProviderStore.filePath(context, FILE_NAME), JSON.stringify(body));
      this.instances = next; this.groups = groups; this.activeId = activeId; this.activeGroupId = activeGroupId;
      this.keys = keys; this.keyBindings.clear();
      for (let i = 0; i < next.length; i++) this.keyBindings.set(next[i].id, this.binding(next[i]));
      const current = this.active(); this.apiKey = current ? this.keyFor(current.id) : '';
      AppStorage.setOrCreate('providerTick', Date.now());
    } catch (error) {
      // 包括 rename 后结果不确定：读回真实 metadata 和匹配代的钥匙，错误仍上抛。
      await this.recoverFromDisk(context);
      throw error as Error;
    }
    for (let i = 0; i < previous.length; i++) {
      const old = previous[i];
      if (old.secretRef) {
        await BoundSecret.retire(old.secretRef);
        await SecretStore.remove(`${OAUTH_ALIAS}.${old.secretRef}`);
      }
      else {
        await SecretStore.removeProviderKeyFor(old.id);
        await SecretStore.remove(`${OAUTH_ALIAS}.${old.id}`);
        if (old.id === 'legacy') await SecretStore.removeProviderKey();
      }
      // 清理只发生在整代 metadata 确认持久化之后。
    }
  }

  save(context: common.Context): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context);
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, this.groups, this.activeGroupId);
    });
  }

  upsert(context: common.Context, input: ProviderInstance, key: string, expectedSnapshot: string | null = null, activateNew: boolean = true): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      const row = ProviderStore.parseInstances(JSON.parse(JSON.stringify([input])) as Object[])[0];
      if (!row) throw new Error('AI 服务商编号不能为空');
      if (row.credential === 'oauth') row.baseUrl = '';
      else if (row.baseUrl.length > 0) row.baseUrl = requireProviderRoot(this.normalizeRoot(row));
      if (!row.model.trim()) row.model = kindByKey(row.type).models[0] ?? '';
      row.model = row.model.trim();
      const old = this.instances.find((item: ProviderInstance) => item.id === row.id);
      if (expectedSnapshot !== null && (old ? JSON.stringify(old) : '') !== expectedSnapshot) throw new Error('同步期间本机服务商已修改，请重新同步');
      const keys = this.snapshotKeys();
      keys.set(row.id, key.trim() || (old && this.binding(old) === this.binding(row) ? this.keyFor(row.id) : ''));
      const next = this.instances.slice();
      const index = next.findIndex((item: ProviderInstance) => item.id === row.id);
      if (index >= 0) next[index] = row; else next.push(row);
      await this.persistSnapshot(context, next, keys, (activateNew && !old) || !this.activeId ? row.id : this.activeId, this.groups, this.activeGroupId);
    });
  }

  setActiveModel(context: common.Context, id: string, model: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable(); const selected = model.trim();
      if (!selected) throw new Error('模型不能空');
      const next = ProviderStore.parseInstances(JSON.parse(JSON.stringify(this.instances)) as Object[]);
      const row = next.find((item: ProviderInstance) => item.id === id && item.enabled);
      if (!row) throw new Error('这个 AI 服务商不可用');
      row.model = selected; if (row.models.indexOf(selected) < 0) row.models = [selected].concat(row.models);
      if (row.deletedModels.indexOf(selected) >= 0 || row.hiddenModels.indexOf(selected) >= 0) {
        row.deletedModels = row.deletedModels.filter((name: string) => name !== selected);
        row.hiddenModels = row.hiddenModels.filter((name: string) => name !== selected);
        row.visibilityEditedAt[selected] = Date.now();
      }
      await this.persistSnapshot(context, next, this.snapshotKeys(), id, this.groups, '');
    });
  }

  remove(context: common.Context, id: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      const gone = this.instances.find((row: ProviderInstance) => row.id === id);
      const next = this.instances.filter((row: ProviderInstance) => row.id !== id);
      const groups = ProviderStore.parseGroups(JSON.parse(JSON.stringify(this.groups)) as Object[]);
      for (let i = 0; i < groups.length; i++) groups[i].modelIds = groups[i].modelIds.filter((entry: string) => !entry.startsWith(`${id}/`));
      const tag = gone ? (gone.label || gone.type) : '';
      if (tag && !next.some((row: ProviderInstance) => (row.label || row.type) === tag)) {
        for (let i = 0; i < groups.length; i++) groups[i].modelIds = groups[i].modelIds.filter((entry: string) => !entry.startsWith(`${id}/`) && !entry.startsWith(`${tag}/`));
      }
      const kept = groups.filter((row: ModelGroup) => row.modelIds.length > 0);
      const keys = this.snapshotKeys(); keys.delete(id);
      await this.persistSnapshot(context, next, keys,
        this.activeId === id ? (next[0]?.id ?? '') : this.activeId, kept,
        kept.some((row: ModelGroup) => row.id === this.activeGroupId) ? this.activeGroupId : '');
    });
  }

  setActive(context: common.Context, id: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      if (!this.instances.some((row: ProviderInstance) => row.id === id && row.enabled)) throw new Error('这个 AI 服务商不可用');
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), id, this.groups, '');
    });
  }

  setActiveGroup(context: common.Context, id: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      if (id && (!this.groups.some((group: ModelGroup) => group.id === id) || this.queue('configuration', id).length === 0)) throw new Error('这组模型尚未可用，请先配置对应服务商');
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, this.groups, id);
    });
  }

  visibleModels(row: ProviderInstance): string[] {
    const models = row.models.length ? row.models : [row.model];
    return models.filter((id: string) => !!id && row.hiddenModels.indexOf(id) < 0 && row.deletedModels.indexOf(id) < 0);
  }

  queue(sessionKey: string = '', requestedGroup: string | null = null, requireCredentials: boolean = true): FailoverSlot[] {
    const slots: ProviderSlot[] = [];
    for (let i = 0; i < this.instances.length; i++) {
      const row = this.instances[i];
      const slot = new ProviderSlot();
      slot.id = row.id;
      slot.label = row.label;
      slot.model = row.model;
      slot.enabled = row.enabled;
      slot.type = row.type;
      slots.push(slot);
    }
    let selected: ModelGroup | null = null;
    let groupIds: string[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      if (this.groups[i].id === (requestedGroup ?? this.activeGroupId)) {
        groupIds = this.groups[i].modelIds.slice(); selected = this.groups[i];
      }
    }
    if (requestedGroup && (!selected || !selected.modelIds.length)) return [];
    let queue = resolveFailoverQueue(this.activeId, slots, groupIds);
    queue = queue.filter((entry: FailoverSlot) => {
      const row = this.instances.find((item: ProviderInstance) => item.id === entry.instanceId); return row !== undefined && row.deletedModels.indexOf(entry.model) < 0 && row.hiddenModels.indexOf(entry.model) < 0 && (!requireCredentials || this.keyFor(row.id).length > 0);
    });
    for (let i = 0; i < queue.length; i++) queue[i].fallbackAlways = selected?.fallbackStrategy === 'always';
    if (selected?.strategy === 'loadBalance' && queue.length > 1) {
      const offset = stableModelIndex(sessionKey || selected.id, queue.length); queue = queue.slice(offset).concat(queue.slice(0, offset));
    }
    return queue;
  }

  captureQueue(source: FailoverSlot[]): ProviderRunSlot[] {
    const output: ProviderRunSlot[] = [];
    for (let i = 0; i < source.length; i++) {
      const entry = source[i]; const row = this.instances.find((item: ProviderInstance) => item.id === entry.instanceId);
      if (!row || !row.enabled || row.deletedModels.indexOf(entry.model) >= 0 || row.hiddenModels.indexOf(entry.model) >= 0) continue;
      const root = this.effectiveRoot(row); const key = this.keyFor(row.id);
      if (!root || !key) continue;
      const slot = new ProviderRunSlot(); slot.instanceId = entry.instanceId; slot.model = entry.model;
      slot.root = root; slot.type = row.type; slot.credential = row.credential; slot.key = key; slot.reference = row.secretRef; slot.fallbackAlways = entry.fallbackAlways;
      const base = JSON.parse(row.modelMetadata[entry.model] || '{}') as Record<string, Object>;
      const overrides = JSON.parse(row.modelOverrides[entry.model] || '{}') as Record<string, Object>;
      const names = Object.keys(overrides); for (const name of names) if (overrides[name] !== null) base[name] = overrides[name];
      slot.metadata = JSON.stringify(base);
      output.push(slot);
    }
    if (!output.length) throw new Error('这个对话的服务商尚未配置完成，请先登录或填写密钥');
    return output;
  }

  slotRoot(instanceId: string): string {
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === instanceId) {
        return this.effectiveRoot(this.instances[i]);
      }
    }
    return this.baseUrl;
  }

  slotType(instanceId: string): string {
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === instanceId) {
        return this.instances[i].type;
      }
    }
    return 'openAI';
  }

  slotCredential(instanceId: string): string {
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === instanceId) {
        return this.instances[i].credential.length > 0 ? this.instances[i].credential : 'apiKey';
      }
    }
    return 'apiKey';
  }

  addGroup(context: common.Context, name: string, modelIds: string[], strategy: string = 'fallback', fallbackStrategy: string = 'limited', thinking: string = '', existingId: string = ''): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      if (!modelIds.length) throw new Error('请至少选择一个模型');
      const old = this.groups.find((row: ModelGroup) => row.id === existingId);
      if (existingId && !old) throw new Error('这组模型已被删除，请重新打开');
      const group = old ? JSON.parse(JSON.stringify(old)) as ModelGroup : new ModelGroup();
      group.id = existingId || `g_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
      group.name = name.trim() || '模型组'; group.modelIds = modelIds.filter((id: string, index: number) => modelIds.indexOf(id) === index);
      group.strategy = strategy === 'loadBalance' ? 'loadBalance' : 'fallback'; group.fallbackStrategy = fallbackStrategy === 'always' ? 'always' : 'limited'; group.defaultThinkingLevel = thinking;
      const now = Date.now() / 1000;
      const previous = old?.modelIds ?? [];
      for (let i = 0; i < previous.length; i++) if (group.modelIds.indexOf(previous[i]) < 0) group.removedMembers[previous[i]] = now;
      for (let i = 0; i < group.modelIds.length; i++) if (previous.indexOf(group.modelIds[i]) < 0) group.addedMembers[group.modelIds[i]] = now;
      const next = old ? this.groups.map((row: ModelGroup) => row.id === group.id ? group : row) : this.groups.concat([group]);
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, next, this.activeGroupId);
    });
  }

  async mergeReplicaGroup(context: common.Context, group: ModelGroup): Promise<void> {
    await this.serial(async () => {
      await this.ensureLoaded(context);
      const groups = ProviderStore.parseGroups(JSON.parse(JSON.stringify(this.groups)) as Object[]);
      const old = groups.find((row: ModelGroup) => row.id === group.id);
      if (old) {
        const members = old.modelIds.concat(group.modelIds);
        const localAdds = Object.keys(old.addedMembers);
        for (let i = 0; i < localAdds.length; i++) group.addedMembers[localAdds[i]] = Math.max(group.addedMembers[localAdds[i]] ?? 0, old.addedMembers[localAdds[i]]);
        const localRemoves = Object.keys(old.removedMembers);
        for (let i = 0; i < localRemoves.length; i++) group.removedMembers[localRemoves[i]] = Math.max(group.removedMembers[localRemoves[i]] ?? 0, old.removedMembers[localRemoves[i]]);
        group.modelIds = members.filter((id: string, index: number) => members.indexOf(id) === index && (group.addedMembers[id] ?? 0) >= (group.removedMembers[id] ?? 0));
      }
      const next = groups.filter((row: ModelGroup) => row.id !== group.id).concat([group]);
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, next, this.activeGroupId);
    });
  }

  removeGroup(context: common.Context, id: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      const next = this.groups.filter((row: ModelGroup) => row.id !== id);
      await this.persistSnapshot(context, this.instances, this.snapshotKeys(), this.activeId, next, this.activeGroupId === id ? '' : this.activeGroupId);
    });
  }

  async refreshModels(context: common.Context, id: string,
    fetch: ((row: ProviderInstance) => Promise<string[]>) | null = null): Promise<ProviderInstance> {
    await this.ensureLoaded(context);
    const current = this.instances.find((row: ProviderInstance) => row.id === id);
    if (!current) throw new Error('先保存再拉模型');
    const snapshot = ProviderStore.parseInstances(JSON.parse(JSON.stringify([current])) as Object[])[0];
    const ids = fetch ? await fetch(snapshot) : await this.fetchModels(snapshot);
    let saved = new ProviderInstance();
    await this.serial(async () => {
      const live = this.instances.find((row: ProviderInstance) => row.id === id);
      if (!live || this.binding(live) !== this.binding(snapshot)) throw new Error('AI 服务商已变化，请重新拉模型');
      const next = ProviderStore.parseInstances(JSON.parse(JSON.stringify(this.instances)) as Object[]);
      const updated = next.find((row: ProviderInstance) => row.id === id)!;
      this.applyModels(updated, ids);
      const models = Object.keys(snapshot.modelMetadata); for (const model of models) updated.modelMetadata[model] = snapshot.modelMetadata[model];
      await this.persistSnapshot(context, next, this.snapshotKeys(), this.activeId, this.groups, this.activeGroupId);
      const committed = this.instances.find((row: ProviderInstance) => row.id === id)!;
      saved = ProviderStore.parseInstances(JSON.parse(JSON.stringify([committed])) as Object[])[0];
    });
    return saved;
  }

  /** 显式清理只采用服务商当次返回的目录，保留手工加入的模型。 */
  async cleanUnavailableModels(context: common.Context, id: string): Promise<number> {
    await this.ensureLoaded(context);
    const row = this.instances.find((item: ProviderInstance) => item.id === id);
    if (!row) throw new Error('AI 服务商已移除');
    if (skipUpstreamModels(row.type, row.credential)) throw new Error('这个登录方式暂不支持核对下线模型');
    const binding = this.binding(row);
    const available = chatModelsFor(row.type, await this.pullUpstream(this.effectiveRoot(row), row.type, this.keyFor(id)));
    if (available.length === 0) throw new Error('服务商返回空目录，本次保留全部模型');
    let removed = 0;
    await this.serial(async () => {
      const next = ProviderStore.parseInstances(JSON.parse(JSON.stringify(this.instances)) as Object[]);
      const live = next.find((item: ProviderInstance) => item.id === id);
      if (!live || this.binding(live) !== binding) throw new Error('AI 服务商已变化，请重试');
      const retired = live.discoveredModels.filter((model: string) => available.indexOf(model) < 0 && model !== live.model);
      removed = retired.length;
      live.models = live.models.filter((model: string) => retired.indexOf(model) < 0);
      live.discoveredModels = available;
      const groups = ProviderStore.parseGroups(JSON.parse(JSON.stringify(this.groups)) as Object[]);
      for (let i = 0; i < groups.length; i++) {
        groups[i].modelIds = groups[i].modelIds.filter((entry: string) => !retired.some((model: string) =>
          entry === `${id}/${model}` || entry === `${live.label || live.type}/${model}`));
      }
      await this.persistSnapshot(context, next, this.snapshotKeys(), this.activeId, groups, this.activeGroupId);
    });
    return removed;
  }

  private async fetchModels(row: ProviderInstance): Promise<string[]> {
    if (skipUpstreamModels(row.type, row.credential)) {
      const built = kindByKey(row.type).models;
      if (row.models.length === 0) {
        row.models = built.slice();
      }
      if (row.model.length === 0 && row.models.length > 0) {
        row.model = row.models[0];
      }
      return row.models;
    }
    const root = this.effectiveRoot(row);
    const key = this.keyFor(row.id);
    if (!root || !key) {
      throw new Error('先保存根和钥匙再拉模型');
    }
    let lastError = '';
    try {
      const ids = await this.pullUpstream(root, row.type, key, row);
      this.applyModels(row, ids);
      return row.models;
    } catch (err) {
      lastError = `${err}`;
    }
    try {
      const ids = await this.pullModelsDev(row.type, row);
      if (ids.length > 0) {
        this.applyModels(row, ids);
        return row.models;
      }
    } catch (_err) {
      // keep lastError
    }
    const built = kindByKey(row.type).models;
    if (built.length > 0) {
      this.applyModels(row, built);
      return row.models;
    }
    throw new Error(lastError.length > 0 ? lastError : '上游没有返回模型');
  }

  private applyModels(row: ProviderInstance, ids: string[]): void {
    const usable = chatModelsFor(row.type, ids);
    const merged = row.models.concat(usable).filter((id: string, index: number, all: string[]) =>
      id.length > 0 && all.indexOf(id) === index && row.deletedModels.indexOf(id) < 0);
    row.models = merged;
    row.discoveredModels = row.discoveredModels.concat(usable).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
    if (!row.model && merged.length > 0) row.model = merged[0];
  }

  private async pullUpstream(root: string, type: string, key: string, target: ProviderInstance | null = null): Promise<string[]> {
    const req = http.createHttp();
    try {
      const resp = await req.request(modelsListUrl(root, type, key), {
        method: http.RequestMethod.GET,
        header: modelsAuthHeaders(type, key),
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      const parsed = JSON.parse(`${resp.result}`) as object;
      const ids = modelIdsFromListJson(parsed);
      if (target) { const metadata = modelMetadataFromList(parsed); const names = Object.keys(metadata); for (const name of names) target.modelMetadata[name] = metadata[name]; }
      if (ids.length === 0) {
        throw new Error('上游没有返回模型');
      }
      return ids;
    } finally {
      req.destroy();
    }
  }

  private async pullModelsDev(type: string, target: ProviderInstance | null = null): Promise<string[]> {
    const providerKey = modelsDevProviderKey(type);
    if (!providerKey) {
      return [];
    }
    const req = http.createHttp();
    try {
      const resp = await req.request(MODELS_DEV_URL, {
        method: http.RequestMethod.GET,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      const parsed = JSON.parse(`${resp.result}`) as object;
      if (target) { const metadata = modelMetadataFromList(parsed, providerKey); const names = Object.keys(metadata); for (const name of names) target.modelMetadata[name] = metadata[name]; }
      return idsFromModelsDevJson(parsed, providerKey);
    } finally {
      req.destroy();
    }
  }

  private normalizeRoot(row: ProviderInstance): string {
    const raw = row.baseUrl.trim() || kindByKey(row.type).root;
    return raw;
  }

  private assertWritable(): void {
    if (this.jsonLoadFailed) {
      throw new Error('AI 服务商档案读坏了，先别保存，避免覆盖');
    }
  }

  private static parseInstances(raw: Object | undefined): ProviderInstance[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: ProviderInstance[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new ProviderInstance();
      row.id = `${item['id'] ?? ''}`;
      row.secretRef = `${item['secretRef'] ?? ''}`;
      row.label = `${item['label'] ?? ''}`;
      row.type = `${item['type'] ?? 'custom'}`;
      row.baseUrl = `${item['baseUrl'] ?? ''}`;
      row.model = `${item['model'] ?? ''}`;
      row.enabled = item['enabled'] !== false;
      row.appendV1 = item['appendV1'] !== false;
      row.azureMode = item['azureMode'] === true;
      row.credential = `${item['credential'] ?? 'apiKey'}` || 'apiKey';
      row.createdAt = Number(item['createdAt'] ?? 0);
      const models = item['models'];
      row.models = Array.isArray(models) ? models.map((id: Object) => `${id}`) : [];
      const discovered = item['discoveredModels'];
      row.discoveredModels = Array.isArray(discovered) ? discovered.map((id: Object) => `${id}`) : [];
      const deleted = item['deletedModels'];
      row.deletedModels = Array.isArray(deleted) ? deleted.map((id: Object) => `${id}`) : [];
      row.modelMetadata = item['modelMetadata'] ? item['modelMetadata'] as Record<string, string> : {};
      row.modelOverrides = item['modelOverrides'] ? item['modelOverrides'] as Record<string, string> : {};
      const hidden = item['hiddenModels'];
      row.hiddenModels = Array.isArray(hidden) ? hidden.map((id: Object) => `${id}`) : [];
      row.visibilityEditedAt = item['visibilityEditedAt'] ? item['visibilityEditedAt'] as Record<string, number> : {};
      if (row.id.length > 0) {
        out.push(row);
      }
    }
    return out;
  }

  private static parseGroups(raw: Object | undefined): ModelGroup[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: ModelGroup[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new ModelGroup();
      row.id = `${item['id'] ?? ''}`;
      row.name = `${item['name'] ?? ''}`;
      row.strategy = item['strategy'] === 'loadBalance' ? 'loadBalance' : 'fallback';
      row.fallbackStrategy = item['fallbackStrategy'] === 'always' ? 'always' : 'limited';
      row.defaultThinkingLevel = `${item['defaultThinkingLevel'] ?? ''}`;
      row.removedMembers = item['removedMembers'] ? item['removedMembers'] as Record<string, number> : {};
      row.addedMembers = item['addedMembers'] ? item['addedMembers'] as Record<string, number> : {};
      const ids = item['modelIds'];
      row.modelIds = Array.isArray(ids) ? ids.map((id: Object) => `${id}`) : [];
      if (row.id.length > 0) {
        out.push(row);
      }
    }
    return out;
  }

  private static filePath(context: common.Context, name: string): string {
    return context.filesDir + '/' + name;
  }


}

export class ProviderLaunch {
  static id: string = '';
  static type: string = '';
  static fromAdd: boolean = false;
}

export const providerStore: ProviderStore = new ProviderStore();
