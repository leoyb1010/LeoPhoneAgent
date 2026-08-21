import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { kindByKey, providerKinds } from '../local/ProviderCatalog';
import { FailoverSlot, ProviderSlot, requireProviderRoot, resolveFailoverQueue } from '../local/LocalProtocol';
import {
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
    return (this.keys.get(id) ?? '').trim();
  }

  rememberKey(id: string, key: string): void {
    this.keys.set(id, key.trim());
    const current = this.active();
    if (current && current.id === id) {
      this.apiKey = key.trim();
    }
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

  ensureLoaded(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (!this.pending) {
      this.pending = this.load(context).catch((err: Error) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  async load(context: common.UIAbilityContext): Promise<void> {
    this.jsonLoadFailed = false;
    this.lastError = '';
    // 重新加载时先清掉内存里的密钥，否则已删除实例的钥匙会一直留在 Map 里
    this.keys.clear();
    const path = ProviderStore.filePath(context, FILE_NAME);
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.activeId = `${obj['activeId'] ?? ''}`;
        this.activeGroupId = `${obj['activeGroupId'] ?? ''}`;
        this.instances = ProviderStore.parseInstances(obj['instances']);
        this.groups = ProviderStore.parseGroups(obj['groups']);
      } catch (err) {
        this.jsonLoadFailed = true;
        this.lastError = `${err}`;
        this.instances = [];
      }
    } else {
      await this.migrateOld(context);
    }
    for (let i = 0; i < this.instances.length; i++) {
      const id = this.instances[i].id;
      const key = await SecretStore.readProviderKeyFor(id);
      if (key.length > 0) {
        this.keys.set(id, key);
      }
    }
    await this.adoptLegacyKey();
    const current = this.active();
    this.apiKey = current ? this.keyFor(current.id) : '';
    this.loaded = true;
  }

  // 老版本只有一个供应商，密钥存在全局别名 leo.harmony.provider_key 下。
  // 以前 SecretStore.readProviderKeyFor 会让「所有」没有自己密钥的实例都读到它，
  // 于是新加的供应商会拿着旧供应商的钥匙去打自己的接口。
  // 这里改成只认领一次：给当前供应商（老档案里就是那唯一一个），认领完立刻删掉全局别名，
  // 之后不会再有第二个实例继承它。
  private async adoptLegacyKey(): Promise<void> {
    const legacy = await SecretStore.readProviderKey();
    if (legacy.length === 0) {
      return;
    }
    // 档案读坏时 instances 被清成空数组，active() 必然是 null，原来的写法照样往下
    // 走到 removeProviderKey() —— 等于把用户唯一的那把钥匙永久销毁，而且这一轮
    // 刚把 readProviderKeyFor 的全局回落删掉，销毁之后再也找不回来。
    // save() 在同样的情况下会 assertWritable() 拒绝落盘（「避免覆盖」），这里保持
    // 同一个态度：什么都不动，等下次启动（或用户修好档案）再认领。
    if (this.jsonLoadFailed) {
      return;
    }
    const target = this.active();
    if (!target) {
      // 一个供应商都没有（全新安装，或老档案迁移没迁出实例）。别名留着不会再被
      // 任何实例读到（readProviderKeyFor 已经不回落了），但删掉就找不回来 —— 留着。
      return;
    }
    if (this.keyFor(target.id).length === 0) {
      this.keys.set(target.id, legacy);
      await SecretStore.writeProviderKeyFor(target.id, legacy);
    }
    // 到这里要么刚认领完，要么目标本来就有自己的钥匙（别名确实冗余了）。
    // 顺序是「先写 per-instance 再删别名」：写失败会抛出去，别名还在，下次启动重来。
    await SecretStore.removeProviderKey();
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    const body = new ProviderFile();
    body.activeId = this.activeId;
    body.activeGroupId = this.activeGroupId;
    body.instances = this.instances;
    body.groups = this.groups;
    ProviderStore.writeText(ProviderStore.filePath(context, FILE_NAME), JSON.stringify(body));
    const current = this.active();
    this.apiKey = current ? this.keyFor(current.id) : '';
    AppStorage.setOrCreate('providerTick', Date.now());
  }

  async upsert(context: common.UIAbilityContext, row: ProviderInstance, key: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    if (row.baseUrl.length > 0) {
      row.baseUrl = requireProviderRoot(this.normalizeRoot(row));
    }
    if (!row.model.trim()) {
      const built = kindByKey(row.type).models;
      row.model = built.length > 0 ? built[0] : '';
    }
    row.model = row.model.trim();
    let found = false;
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i].id === row.id) {
        this.instances[i] = row;
        found = true;
        break;
      }
    }
    if (!found) {
      this.instances = this.instances.concat([row]);
      this.activeId = row.id;
    } else if (!this.activeId) {
      this.activeId = row.id;
    }
    if (key.trim().length > 0) {
      this.keys.set(row.id, key.trim());
      await SecretStore.writeProviderKeyFor(row.id, key.trim());
    }
    await this.save(context);
  }

  async setActiveModel(context: common.UIAbilityContext, id: string, model: string): Promise<void> {
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

  async remove(context: common.UIAbilityContext, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    this.instances = this.instances.filter((row: ProviderInstance) => row.id !== id);
    this.keys.delete(id);
    // 之前只清了内存里的 Map，Asset 库里这个实例的 API Key 和 OAuth refresh_token 都还留着。
    // 删了供应商却把凭据留在设备上，属于该清没清。
    await SecretStore.removeProviderKeyFor(id);
    await SecretStore.remove(`${OAUTH_ALIAS}.${id}`);
    if (this.activeId === id) {
      this.activeId = this.instances.length > 0 ? this.instances[0].id : '';
    }
    await this.save(context);
  }

  async setActive(context: common.UIAbilityContext, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    this.activeId = id;
    await this.save(context);
  }

  async setActiveGroup(context: common.UIAbilityContext, id: string): Promise<void> {
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

  async addGroup(context: common.UIAbilityContext, name: string, modelIds: string[]): Promise<void> {
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

  async removeGroup(context: common.UIAbilityContext, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.groups = this.groups.filter((row: ModelGroup) => row.id !== id);
    if (this.activeGroupId === id) {
      this.activeGroupId = '';
    }
    await this.save(context);
  }

  async refreshModels(row: ProviderInstance): Promise<string[]> {
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
    row.models = ids;
    if (ids.indexOf(row.model) < 0) {
      row.model = ids[0];
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

  private async migrateOld(context: common.UIAbilityContext): Promise<void> {
    const path = ProviderStore.filePath(context, OLD_FILE);
    if (!fileIo.accessSync(path)) {
      return;
    }
    try {
      const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
      const baseUrl = `${obj['baseUrl'] ?? ''}`;
      const model = `${obj['model'] ?? 'gpt-4o-mini'}`;
      if (!baseUrl) {
        return;
      }
      const row = new ProviderInstance();
      row.id = 'legacy';
      row.label = '本机供应商';
      row.type = 'custom';
      row.baseUrl = baseUrl;
      row.model = model;
      row.models = [model];
      row.createdAt = Date.now();
      this.instances = [row];
      this.activeId = row.id;
      const oldKey = await SecretStore.readProviderKey();
      if (oldKey.length > 0) {
        this.keys.set(row.id, oldKey);
        await SecretStore.writeProviderKeyFor(row.id, oldKey);
      }
      // 这里原来调的是 this.save(context)，而 save() 第一行是 await this.ensureLoaded(context)。
      // migrateOld 只会在 load() 内部被调用，此时 ensureLoaded 的 pending 就是当前这个 load 的
      // Promise —— 于是 save 等 load、load 等 save，直接死锁：ensureLoaded 永远不 resolve。
      // 触发条件是「有旧 provider.json、没有新 providers.json」，也就是老版本覆盖升级的用户，
      // 表现为本机聊天永远停在「准备中」、定时任务和当身体全部静默不动。
      // 改成直接落盘：此刻 instances/activeId 已经就绪，不需要再走 save() 那圈。
      const body = new ProviderFile();
      body.activeId = this.activeId;
      body.activeGroupId = this.activeGroupId;
      body.instances = this.instances;
      body.groups = this.groups;
      ProviderStore.writeText(ProviderStore.filePath(context, FILE_NAME), JSON.stringify(body));
    } catch (err) {
      this.jsonLoadFailed = true;
      this.lastError = `${err}`;
    }
  }

  private assertWritable(): void {
    if (this.jsonLoadFailed) {
      throw new Error('供应商档案读坏了，先别保存，避免覆盖');
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

  private static filePath(context: common.UIAbilityContext, name: string): string {
    return context.filesDir + '/' + name;
  }

  private static writeText(path: string, text: string): void {
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, text);
    } finally {
      fileIo.closeSync(file);
    }
  }
}

export class ProviderLaunch {
  static id: string = '';
  static type: string = '';
  static fromAdd: boolean = false;
}

export const providerStore: ProviderStore = new ProviderStore();
