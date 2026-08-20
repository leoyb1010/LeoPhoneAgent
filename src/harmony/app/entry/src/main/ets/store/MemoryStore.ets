import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class MemoryStore {
  global: string = '';
  today: string = '';
  jsonLoadFailed: boolean = false;
  private stamp: string = '';

  async load(context: common.UIAbilityContext): Promise<void> {
    this.roll();
    MemoryStore.ensureDir(MemoryStore.dir(context));
    this.global = MemoryStore.readIfPresent(MemoryStore.globalPath(context));
    this.today = MemoryStore.readIfPresent(MemoryStore.dailyPath(context));
  }

  async saveGlobal(context: common.UIAbilityContext, text: string): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('记忆档案读坏了，先别保存，避免覆盖');
    }
    this.global = text;
    MemoryStore.ensureDir(MemoryStore.dir(context));
    MemoryStore.writeText(MemoryStore.globalPath(context), text);
  }

  async appendToday(context: common.UIAbilityContext, text: string): Promise<void> {
    this.roll();
    const next = this.today.length > 0 ? `${this.today}\n${text}` : text;
    this.today = next;
    MemoryStore.ensureDir(MemoryStore.dir(context));
    MemoryStore.writeText(MemoryStore.dailyPath(context), next);
  }

  search(scope: string, keywords: string): string {
    const hay = scope === 'daily' ? this.today : `${this.global}\n${this.today}`;
    const trimmed = hay.trim();
    if (!trimmed) {
      return '没有记忆';
    }
    const keys = keywords.trim().toLowerCase().split(' ');
    const needles: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].length > 0) {
        needles.push(keys[i]);
      }
    }
    if (needles.length === 0) {
      return trimmed;
    }
    const lines = trimmed.split('\n');
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const start = i > 0 ? i - 1 : 0;
      const end = i + 2 < lines.length ? i + 2 : lines.length;
      let window = '';
      for (let j = start; j < end; j++) {
        window += `${lines[j].toLowerCase()}\n`;
      }
      let ok = true;
      for (let k = 0; k < needles.length; k++) {
        if (window.indexOf(needles[k]) < 0) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hits.push(lines[i]);
      }
    }
    return hits.length > 0 ? hits.join('\n') : '没有匹配的记忆';
  }

  promptBlock(): string {
    this.roll();
    const parts: string[] = [];
    if (this.global.trim().length > 0) {
      parts.push(`GLOBAL.md:\n${this.global.trim()}`);
    }
    if (this.today.trim().length > 0) {
      parts.push(`今日记忆:\n${this.today.trim()}`);
    }
    return parts.join('\n\n');
  }

  private roll(): void {
    const key = MemoryStore.dayKey();
    if (this.stamp !== key) {
      this.stamp = key;
      this.today = '';
    }
  }

  private static dayKey(): string {
    const now = new Date();
    const m = `${now.getMonth() + 1}`.padStart(2, '0');
    const d = `${now.getDate()}`.padStart(2, '0');
    return `${now.getFullYear()}-${m}-${d}`;
  }

  private static dir(context: common.UIAbilityContext): string {
    return context.filesDir + '/memory';
  }

  private static globalPath(context: common.UIAbilityContext): string {
    return MemoryStore.dir(context) + '/GLOBAL.md';
  }

  private static dailyPath(context: common.UIAbilityContext): string {
    const now = new Date();
    const m = `${now.getMonth() + 1}`.padStart(2, '0');
    const d = `${now.getDate()}`.padStart(2, '0');
    return `${MemoryStore.dir(context)}/${now.getFullYear()}-${m}-${d}.md`;
  }

  private static readIfPresent(path: string): string {
    if (!fileIo.accessSync(path)) {
      return '';
    }
    return fileIo.readTextSync(path);
  }

  private static ensureDir(path: string): void {
    if (!fileIo.accessSync(path)) {
      fileIo.mkdirSync(path);
    }
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

export const memoryStore: MemoryStore = new MemoryStore();
