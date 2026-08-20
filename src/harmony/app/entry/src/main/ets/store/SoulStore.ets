import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class SoulStore {
  text: string = '';
  jsonLoadFailed: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
    const path = context.filesDir + '/SOUL.md';
    if (!fileIo.accessSync(path)) {
      this.text = '';
      return;
    }
    try {
      this.text = fileIo.readTextSync(path);
    } catch (_err) {
      this.jsonLoadFailed = true;
      this.text = '';
    }
  }

  async save(context: common.UIAbilityContext, text: string): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('SOUL.md 读坏了，先别保存');
    }
    this.text = text;
    const path = context.filesDir + '/SOUL.md';
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, text);
    } finally {
      fileIo.closeSync(file);
    }
  }

  promptBlock(): string {
    const body = this.text.trim();
    return body.length > 0 ? `SOUL.md\n${body}` : '';
  }
}

export const soulStore: SoulStore = new SoulStore();
