import { BoundSecret } from './BoundSecret';
import { AtomicTextFile } from './AtomicFile';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { kindByKey, providerKinds } from '../local/ProviderCatalog';
import { FailoverSlot, ProviderSlot, requireProviderRoot, resolveFailoverQueue } from '../local/LocalProtocol';
import {
  chatModelsFor,
  idsFromModelsDevJson,
  MODELS_DEV_URL,
  modelIdsFromListJson,
  modelsAuthHeaders,
  modelsDevProviderKey,
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
  enabled: boolean = true;
  appendV1: boolean = true;
  azureMode: boolean = false;
  credential: string = 'apiKey';
  createdAt: number = 0;
}

export class ModelGroup {
  id: string = '';
  name: string = '';
  modelIds: string[] = [];
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
    const row = this.active();
    if (!row || !row.enabled) {
      return false;
    }
    return this.effectiveRoot(row).length > 0 && row.model.length > 0 && this.keyFor(row.id).length > 0;
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
      throw error;
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
      throw error;
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

  upsert(context: common.Context, input: ProviderInstance, key: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      const row = ProviderStore.parseInstances(JSON.parse(JSON.stringify([input])) as Object[])[0];
      if (!row) throw new Error('AI 服务商编号不能为空');
      if (row.credential === 'oauth') row.baseUrl = '';
      else if (row.baseUrl.length > 0) row.baseUrl = requireProviderRoot(this.normalizeRoot(row));
      if (!row.model.trim()) row.model = kindByKey(row.type).models[0] ?? '';
      row.model = row.model.trim();
      const old = this.instances.find((item: ProviderInstance) => item.id === row.id);
      const keys = this.snapshotKeys();
      keys.set(row.id, key.trim() || (old && this.binding(old) === this.binding(row) ? this.keyFor(row.id) : ''));
      const next = this.instances.slice();
      const index = next.findIndex((item: ProviderInstance) => item.id === row.id);
      if (index >= 0) next[index] = row; else next.push(row);
      await this.persistSnapshot(context, next, keys, !old || !this.activeId ? row.id : this.activeId, this.groups, this.activeGroupId);
    });
  }

  async setActiveModel(context: common.Context, id: string, model: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    const next = model.trim();
    if (!next) {
      throw new Error('模型不能空');
    }
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === id) {
        this.instances[i].model = next;
        if (this.instances[i].models.indexOf(next) < 0) {
          this.instances[i].models = [next].concat(this.instances[i].models);
        }
      }
    }
    this.activeId = id;
    await this.save(context);
  }

  remove(context: common.Context, id: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureLoaded(context); this.assertWritable();
      const gone = this.instances.find((row: ProviderInstance) => row.id === id);
      const next = this.instances.filter((row: ProviderInstance) => row.id !== id);
      const groups = ProviderStore.parseGroups(JSON.parse(JSON.stringify(this.groups)) as Object[]);
      const tag = gone ? (gone.label || gone.type) : '';
      if (tag && !next.some((row: ProviderInstance) => (row.label || row.type) === tag)) {
        for (let i = 0; i < groups.length; i++) groups[i].modelIds = groups[i].modelIds.filter((entry: string) => !entry.startsWith(`${tag}/`));
      }
      const kept = groups.filter((row: ModelGroup) => row.modelIds.length > 0);
      const keys = this.snapshotKeys(); keys.delete(id);
      await this.persistSnapshot(context, next, keys,
        this.activeId === id ? (next[0]?.id ?? '') : this.activeId, kept,
        kept.some((row: ModelGroup) => row.id === this.activeGroupId) ? this.activeGroupId : '');
    });
  }

  async setActive(context: common.Context, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    this.activeId = id;
    await this.save(context);
  }

  async setActiveGroup(context: common.Context, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    this.activeGroupId = id;
    await this.save(context);
  }

  queue(): FailoverSlot[] {
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
    let groupIds: string[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      if (this.groups[i].id === this.activeGroupId) {
        groupIds = this.groups[i].modelIds.slice();
      }
    }
    return resolveFailoverQueue(this.activeId, slots, groupIds);
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

  async addGroup(context: common.Context, name: string, modelIds: string[]): Promise<void> {
    // 必须先 ensureLoaded 再改 this.groups。原来是先 concat 再 save()，
    // 而 save() 内部的 ensureLoaded 若此刻才第一次读盘，会用磁盘内容整个覆盖 this.groups，
    // 刚加的组直接消失（removeGroup 同理）。
    await this.ensureLoaded(context);
    const group = new ModelGroup();
    group.id = `g_${Date.now()}`;
    group.name = name.trim() || '模型组';
    group.modelIds = modelIds;
    this.groups = this.groups.concat([group]);
    await this.save(context);
  }

  async removeGroup(context: common.Context, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.groups = this.groups.filter((row: ModelGroup) => row.id !== id);
    if (this.activeGroupId === id) {
      this.activeGroupId = '';
    }
    await this.save(context);
  }

  /** 拉取使用快照，提交只更新当前实例的模型字段，允许期间发生同一服务商的 OAuth 换代。 */
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
      await this.persistSnapshot(context, next, this.snapshotKeys(), this.activeId, this.groups, this.activeGroupId);
      const committed = this.instances.find((row: ProviderInstance) => row.id === id)!;
      saved = ProviderStore.parseInstances(JSON.parse(JSON.stringify([committed])) as Object[])[0];
    });
    return saved;
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
      const ids = await this.pullUpstream(root, row.type, key);
      this.applyModels(row, ids);
      return row.models;
    } catch (err) {
      lastError = `${err}`;
    }
    try {
      const ids = await this.pullModelsDev(row.type);
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
    row.models = usable;
    if (usable.indexOf(row.model) < 0) {
      row.model = usable[0];
    }
  }

  private async pullUpstream(root: string, type: string, key: string): Promise<string[]> {
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
      const ids = modelIdsFromListJson(JSON.parse(`${resp.result}`) as object);
      if (ids.length === 0) {
        throw new Error('上游没有返回模型');
      }
      return ids;
    } finally {
      req.destroy();
    }
  }

  private async pullModelsDev(type: string): Promise<string[]> {
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
      return idsFromModelsDevJson(JSON.parse(`${resp.result}`) as object, providerKey);
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
