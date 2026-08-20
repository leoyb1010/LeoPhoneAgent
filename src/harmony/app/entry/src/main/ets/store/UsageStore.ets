import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

class UsageFile {
  turns: number = 0;
  prompt: number = 0;
  completion: number = 0;
}

export class UsageStore {
  turns: number = 0;
  prompt: number = 0;
  completion: number = 0;
  private loaded: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return;
    }
    const path = context.filesDir + '/usage.json';
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.turns = Number(obj['turns'] ?? 0);
        this.prompt = Number(obj['prompt'] ?? 0);
        this.completion = Number(obj['completion'] ?? 0);
      } catch (_err) {
        this.turns = 0;
      }
    }
    this.loaded = true;
  }

  async add(context: common.UIAbilityContext, prompt: number, completion: number): Promise<void> {
    await this.load(context);
    this.turns += 1;
    this.prompt += prompt;
    this.completion += completion;
    const body = new UsageFile();
    body.turns = this.turns;
    body.prompt = this.prompt;
    body.completion = this.completion;
    const path = context.filesDir + '/usage.json';
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(body));
    } finally {
      fileIo.closeSync(file);
    }
  }
}

export const usageStore: UsageStore = new UsageStore();
