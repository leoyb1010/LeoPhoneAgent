import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class CollectionItem {
  id: string = '';
  title: string = '';
  body: string = '';
  createdAt: number = 0;
}

export class CollectionStore {
  items: CollectionItem[] = [];
  jsonLoadFailed: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
    const path = CollectionStore.filePath(context);
    if (!fileIo.accessSync(path)) {
      this.items = [];
      return;
    }
    try {
      const parsed = JSON.parse(fileIo.readTextSync(path)) as Object[];
      this.items = parsed.map((row: Object) => {
        const item = row as Record<string, Object>;
        const out = new CollectionItem();
        out.id = `${item['id'] ?? ''}`;
        out.title = `${item['title'] ?? ''}`;
        out.body = `${item['body'] ?? ''}`;
        out.createdAt = Number(item['createdAt'] ?? 0);
        return out;
      }).filter((row: CollectionItem) => row.id.length > 0);
    } catch (_err) {
      this.jsonLoadFailed = true;
      this.items = [];
    }
  }

  async add(context: common.UIAbilityContext, title: string, body: string): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('藏宝阁档案读坏了，先别保存，避免覆盖');
    }
    const item = new CollectionItem();
    item.id = `c_${Date.now()}`;
    item.title = title.trim().length > 0 ? title.trim() : body.trim().substring(0, 32);
    item.body = body;
    item.createdAt = Date.now();
    this.items = [item].concat(this.items);
    CollectionStore.writeText(CollectionStore.filePath(context), JSON.stringify(this.items));
  }

  promptBlock(): string {
    if (this.items.length === 0) {
      return '';
    }
    const top = this.items.slice(0, 8);
    return '藏宝阁:\n' + top.map((row: CollectionItem) => `- ${row.title}: ${row.body}`).join('\n');
  }

  private static filePath(context: common.UIAbilityContext): string {
    return context.filesDir + '/collections.json';
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

export const collectionStore: CollectionStore = new CollectionStore();
