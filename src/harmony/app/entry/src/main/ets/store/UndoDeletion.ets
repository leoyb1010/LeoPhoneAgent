export class PendingDeletion {
  id: string = '';
  title: string = '';
  expires: number = 0;
  timer: number = -1;
}
/** Delete is delayed, not undone by recreating files. No data is destroyed before the grace period. */
export class UndoDeletion {
  private static pending: Map<string, PendingDeletion> = new Map();
  static error: string = '';
  static entries(): PendingDeletion[] { return Array.from(UndoDeletion.pending.values()); }
  static hidden(id: string): boolean { return UndoDeletion.pending.has(id); }
  static stage(id: string, title: string, commit: () => Promise<void>): void {
    if (UndoDeletion.pending.has(id)) return;
    const entry = new PendingDeletion(); entry.id = id; entry.title = title; entry.expires = Date.now() + 5000;
    UndoDeletion.pending.set(id, entry); UndoDeletion.error = ''; UndoDeletion.changed();
    entry.timer = setTimeout(async () => {
      if (UndoDeletion.pending.get(id) !== entry) return;
      // Remove from the undo list before beginning irreversible work: undo never claims to cancel in-flight I/O.
      UndoDeletion.pending.delete(id); UndoDeletion.changed();
      try { await commit(); }
      catch (_error) { UndoDeletion.error = '删除未完成，请检查对话列表后重试'; }
      UndoDeletion.changed();
    }, 5000);
  }
  static undo(id: string): boolean {
    const entry = UndoDeletion.pending.get(id);
    if (!entry || Date.now() >= entry.expires) return false;
    clearTimeout(entry.timer); UndoDeletion.pending.delete(id); UndoDeletion.changed(); return true;
  }
  private static changed(): void { AppStorage.setOrCreate('deletionTick', (AppStorage.get<number>('deletionTick') ?? 0) + 1); }
}
