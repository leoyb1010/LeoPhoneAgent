import { BackupStore } from '../backup/BackupStore';
import { common, Want } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { preferences } from '@kit.ArkData';

export class SharedDraft {
  id: string = '';
  text: string = '';
  files: string[] = [];
  receivedAt: number = 0;
}

/** Share targets import granted URIs into app-owned files. Receiving never sends a model request. */
export class ShareInbox {
  private static writes: Promise<void> = Promise.resolve();
  static receive(context: common.Context, want: Want): Promise<boolean> {
    let received = false;
    const work = ShareInbox.writes.catch(() => {}).then(async () => {
      const lease = BackupStore.beginExecution(context);
      try { received = await ShareInbox.receiveNow(context, want); } finally { lease.release(); }
    });
    ShareInbox.writes = work;
    return work.then(() => received);
  }
  private static async receiveNow(context: common.Context, want: Want): Promise<boolean> {
    if (want.action !== 'ohos.want.action.sendData') {
      return false;
    }
    if (await ShareInbox.peek(context)) {
      throw new Error('已有待处理的分享，请先在系统集成页处理');
    }
    const params = want.parameters;
    const text = params ? `${params['ohos.extra.param.key.content'] ?? params['ohos.extra.param.key.text'] ?? ''}` : '';
    if (text.length > 1024 * 1024) {
      throw new Error('分享文字超过 1 MB');
    }
    const draft = new SharedDraft();
    draft.id = util.generateRandomUUID(true);
    draft.text = text;
    draft.receivedAt = Date.now();
    const uri = want.uri ?? '';
    if (uri) {
      if (!/^file:\/\/(?:docs|media)\//.test(uri)) {
        throw new Error('只接收系统授予访问权的文件');
      }
      const source = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      try {
        const info = fileIo.statSync(source.fd);
        if (!info.isFile() || info.size > 32 * 1024 * 1024) {
          throw new Error('分享文件超过 32 MB 或类型不支持');
        }
        const name = 'shared-' + util.generateRandomUUID(true) + '.bin';
        const directory = context.filesDir + '/workspace';
        if (!fileIo.accessSync(directory)) {
          fileIo.mkdirSync(directory);
        }
        const destination = fileIo.openSync(directory + '/' + name,
          fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE);
        try {
          fileIo.copyFileSync(source.fd, destination.fd);
          fileIo.fsyncSync(destination.fd);
          draft.files.push(name);
        } finally {
          fileIo.closeSync(destination);
        }
      } finally {
        fileIo.closeSync(source);
      }
    }
    if (!draft.text && draft.files.length === 0) {
      return false;
    }
    const store = await preferences.getPreferences(context, 'leo.harmony.share');
    await store.put('pending', JSON.stringify(draft));
    await store.flush();
    AppStorage.setOrCreate('sharedDraftTick', draft.receivedAt);
    return true;
  }

  static async peek(context: common.Context): Promise<SharedDraft | null> {
    const lease = BackupStore.beginExecution(context);
    try {
      const store = await preferences.getPreferences(context, 'leo.harmony.share');
      const raw = `${await store.get('pending', '')}`;
      if (!raw) {
        return null;
      }
      const draft = JSON.parse(raw) as SharedDraft;
      if (!draft.id) { draft.id = 'legacy-' + draft.receivedAt; }
      return draft;
    } finally { lease.release(); }
  }

  static clear(context: common.Context, expectedId: string = ''): Promise<void> {
    const work = ShareInbox.writes.catch(() => {}).then(async () => {
      const lease = BackupStore.beginExecution(context);
      try {
        const current = await ShareInbox.peek(context);
        if (!current || (expectedId && current.id !== expectedId)) { return; }
        const store = await preferences.getPreferences(context, 'leo.harmony.share');
        await store.delete('pending');
        await store.flush();
      } finally { lease.release(); }
    });
    ShareInbox.writes = work;
    return work;
  }
}
