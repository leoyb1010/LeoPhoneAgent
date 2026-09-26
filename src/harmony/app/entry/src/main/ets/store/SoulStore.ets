import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { parseSkillMeta } from '../local/AgentText';

export class SoulStore {
  text: string = '';
  jsonLoadFailed: boolean = false;

  async load(context: common.Context): Promise<void> {
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

  async save(context: common.Context, text: string): Promise<void> {
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

  /** SOUL.md 的 --- 头里写的名字(回答头、「正在思考」用它,和 iOS 一样);没写返回空。 */
  name(): string {
    return parseSkillMeta(this.text, '').name;
  }

  promptBlock(): string {
    const body = this.text.trim();
    return body.length > 0 ? `SOUL.md\n${body}` : '';
  }
}

export const soulStore: SoulStore = new SoulStore();
