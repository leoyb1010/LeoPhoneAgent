import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class EnvEntry {
  name: string = '';
  value: string = '';
}

class EnvFile {
  rows: EnvEntry[] = [];
}

export class EnvStore {
  rows: EnvEntry[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return;
    }
    const path = context.filesDir + '/env.json';
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.rows = EnvStore.parse(obj['rows']);
      } catch (_err) {
        this.jsonLoadFailed = true;
        this.rows = [];
      }
    }
    this.loaded = true;
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('环境变量档案读坏了，先别保存');
    }
    const body = new EnvFile();
    body.rows = this.rows;
    const path = context.filesDir + '/env.json';
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(body));
    } finally {
      fileIo.closeSync(file);
    }
  }

  async upsert(context: common.UIAbilityContext, name: string, value: string): Promise<void> {
    const key = name.trim();
    if (!key) {
      throw new Error('变量名不能空');
    }
    let found = false;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].name === key) {
        this.rows[i].value = value;
        found = true;
        break;
      }
    }
    if (!found) {
      const row = new EnvEntry();
      row.name = key;
      row.value = value;
      this.rows = this.rows.concat([row]);
    }
    await this.save(context);
  }

  async remove(context: common.UIAbilityContext, name: string): Promise<void> {
    const next: EnvEntry[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].name !== name) {
        next.push(this.rows[i]);
      }
    }
    this.rows = next;
    await this.save(context);
  }

  promptBlock(): string {
    if (this.rows.length === 0) {
      return '';
    }
    const lines: string[] = ['环境变量'];
    for (let i = 0; i < this.rows.length; i++) {
      lines.push(`${this.rows[i].name}=${this.rows[i].value}`);
    }
    return lines.join('\n');
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
      if (row.name.length > 0) {
        out.push(row);
      }
    }
    return out;
  }
}

export const envStore: EnvStore = new EnvStore();
