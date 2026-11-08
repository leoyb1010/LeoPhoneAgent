import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { formBindingData, formProvider } from '@kit.FormKit';
import { AtomicTextFile, atomicWriteText } from '../store/AtomicFile';

export class FormSnapshot {
  runningCount: number = 0;
  approvalCount: number = 0;
  sessionId: string = '';
  updatedAt: number = 0;
}

export class FormStatus {
  private static context: common.Context | null = null;

  static attach(context: common.Context): void {
    FormStatus.context = context;
  }

  static read(context: common.Context): FormSnapshot {
    const path = context.filesDir + '/form-status.json';
    const snapshot = new FormSnapshot();
    if (!fileIo.accessSync(path)) return snapshot;
    try {
      const row = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
      snapshot.runningCount = Math.max(0, Math.min(999, Math.floor(Number(row['runningCount']) || 0)));
      snapshot.approvalCount = Math.max(0, Math.min(999, Math.floor(Number(row['approvalCount']) || 0)));
      const id = String(row['sessionId'] ?? '');
      if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) snapshot.sessionId = id;
      snapshot.updatedAt = Number(row['updatedAt']) || 0;
    } catch (_error) {
      // An unreadable cache is unknown state, not proof that tasks failed.
    }
    return snapshot;
  }

  static publish(runningCount: number, approvalCount: number, sessionId: string): void {
    const context = FormStatus.context;
    if (!context) return;
    const snapshot = new FormSnapshot();
    snapshot.runningCount = runningCount;
    snapshot.approvalCount = approvalCount;
    snapshot.sessionId = sessionId;
    snapshot.updatedAt = Date.now();
    try {
      atomicWriteText(context.filesDir + '/form-status.json', JSON.stringify(snapshot));
      const ids = FormStatus.ids(context);
      ids.forEach((id: string) => {
        formProvider.updateForm(id, formBindingData.createFormBindingData(snapshot)).catch(() => {});
      });
    } catch (_error) {
      // Task execution remains independent of a home-screen cache write.
    }
  }

  static remember(context: common.Context, id: string, added: boolean): void {
    if (!/^[0-9]{1,32}$/.test(id)) return;
    const store = new AtomicTextFile();
    const path = context.filesDir + '/form-identities.json';
    const raw = store.read(path);
    const previous = raw ? JSON.parse(raw) as string[] : [];
    const next = previous.filter((value: string) => value !== id);
    if (added) next.push(id);
    store.write(path, JSON.stringify(next));
  }

  private static ids(context: common.Context): string[] {
    const path = context.filesDir + '/form-identities.json';
    if (!fileIo.accessSync(path)) return [];
    const parsed = JSON.parse(fileIo.readTextSync(path)) as Object[];
    return parsed.filter((value: Object) => typeof value === 'string' && /^[0-9]{1,32}$/.test(value as string)) as string[];
  }
}
