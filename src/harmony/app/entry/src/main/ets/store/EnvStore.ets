import { BoundSecret } from './BoundSecret';
import { AtomicTextFile } from './AtomicFile';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { envPromptBlock, expandEnvPlaceholders, referencesEnv } from '../local/LocalProtocol';
import { SecretStore } from './SecretStore';

export class EnvEntry {
  name: string = '';
  secretRef: string = '';
  value: string = '';
}

class EnvFile {
  rows: EnvEntry[] = [];
}

export class EnvStore {
  private readonly configFile: AtomicTextFile = new AtomicTextFile();
  rows: EnvEntry[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;
  private pendingLoad: Promise<void> | null = null;

  private writes: Promise<void> = Promise.resolve();

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.writes.then(action);
    this.writes = next.catch(() => {});
    return next;
  }

  reload(context: common.Context): Promise<void> {
    return this.serial(async () => {
      if (this.pendingLoad) await this.pendingLoad.catch(() => {});
      this.loaded = false; this.rows = []; this.jsonLoadFailed = false;
      await this.readDisk(context, false);
    });
  }

  async load(context: common.Context): Promise<void> {
    if (this.pendingLoad) { await this.pendingLoad; return; }
    if (this.loaded) return;
    if (!this.pendingLoad) this.pendingLoad = this.readDisk(context, true).finally(() => { this.pendingLoad = null; });
    await this.pendingLoad;
  }

  private async readDisk(context: common.Context, migrate: boolean): Promise<void> {
    let needsMigration = false;
    const path = context.filesDir + '/env.json';
    try {
      const raw = this.configFile.read(path);
      this.rows = raw ? EnvStore.parse((JSON.parse(raw) as Record<string, Object>)['rows']) : [];
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        if (!row.secretRef) needsMigration = true;
        row.value = row.secretRef ? await BoundSecret.read(row.secretRef, EnvStore.binding(row.name)) :
          (row.value || await SecretStore.read(EnvStore.alias(row.name)));
      }
      this.jsonLoadFailed = false;
      this.loaded = true;
    } catch (error) {
      this.rows = [];
      this.jsonLoadFailed = true;
      this.loaded = false;
      throw error;
    }
    if (migrate && needsMigration) await this.persist(context, this.rows);
  }

  save(context: common.Context): Promise<void> {
    return this.serial(async () => { await this.load(context); await this.persist(context, this.rows); });
  }

  private async persist(context: common.Context, rows: EnvEntry[]): Promise<void> {
    if (this.jsonLoadFailed) throw new Error('环境变量档案读坏了，先别保存');
    const previous = this.rows;
    const next = EnvStore.parse(JSON.parse(JSON.stringify(rows)) as Object[]);
    try {
      const body = new EnvFile();
      for (let i = 0; i < next.length; i++) {
        const row = next[i];
        if (!row.secretRef) row.secretRef = await BoundSecret.stage(EnvStore.binding(row.name), row.value);
        const bare = new EnvEntry();
        bare.name = row.name;
        bare.secretRef = row.secretRef;
        body.rows.push(bare);
      }
      this.configFile.write(context.filesDir + '/env.json', JSON.stringify(body));
      this.rows = next;
    } catch (error) {
      // 恢复不能等待正在执行本次迁移的 pendingLoad，否则会自等待。
      this.rows = []; this.jsonLoadFailed = false;
      await this.readDisk(context, false);
      throw error;
    }
    // 只有 metadata 确认持久化以后才清理旧代；失败/过期写者绝不删除胜者的凭据。
    for (let i = 0; i < previous.length; i++) {
      const old = previous[i];
      if (old.secretRef && !next.some((row: EnvEntry) => row.secretRef === old.secretRef)) await BoundSecret.retire(old.secretRef);
      if (!old.secretRef) await SecretStore.remove(EnvStore.alias(old.name));
    }
  }

  upsert(context: common.Context, name: string, value: string): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const key = name.trim();
      if (!key) throw new Error('变量名不能空');
      const row = new EnvEntry(); row.name = key; row.value = value;
      const next = this.rows.slice();
      const index = next.findIndex((item: EnvEntry) => item.name === key);
      if (index >= 0) next[index] = row; else next.push(row);
      await this.persist(context, next);
    });
  }

  remove(context: common.Context, name: string): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      await this.persist(context, this.rows.filter((row: EnvEntry) => row.name !== name));
    });
  }

  private static binding(name: string): string { return JSON.stringify(['env', name]); }

  private static alias(name: string): string {
    return `leo.harmony.env.${name}`;
  }

  /**
   * 只告诉模型有哪些变量,不发值(原来把「名字=值」明文写进系统提示,钥匙会跟着对话发给 AI 服务商)。
   * 模型在工具参数里写 $$名字,执行时由 expand 换成真实值,和 iOS 的占位写法一样。
   */
  promptBlock(): string {
    return envPromptBlock(this.rows.map((row: EnvEntry) => row.name));
  }

  referenced(args: string): boolean {
    return referencesEnv(args, this.rows.map((row: EnvEntry) => row.name));
  }

  expand(args: string): string {
    const values: Map<string, string> = new Map();
    for (let i = 0; i < this.rows.length; i++) {
      values.set(this.rows[i].name, this.rows[i].value);
    }
    return expandEnvPlaceholders(args, values);
  }

  private static parse(raw: Object | undefined): EnvEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: EnvEntry[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new EnvEntry();
      row.name = `${item['name'] ?? ''}`.trim();
      row.value = `${item['value'] ?? ''}`;
      row.secretRef = `${item['secretRef'] ?? ''}`;
      if (row.name.length > 0) {
        out.push(row);
      }
    }
    return out;
  }
}

export const envStore: EnvStore = new EnvStore();
