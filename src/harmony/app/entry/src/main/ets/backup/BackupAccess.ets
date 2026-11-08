import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';

/** Kernel flock ownership follows the open file description, including across app processes. */
export class BackupLease {
  private file: fileIo.File | null = null;
  constructor(file: fileIo.File) { this.file = file; }
  release(): void {
    const file = this.file; this.file = null;
    if (file) { fileIo.closeSync(file); }
  }
}
export class BackupAccess {
  static pending(context: common.Context): boolean {
    return fileIo.accessSync(context.filesDir + '/restore-journal.json') || fileIo.accessSync(context.filesDir + '/restore-journal-v2.json');
  }
  static requireReady(context: common.Context): void {
    const lease = BackupAccess.beginExecution(context); lease.release();
  }
  static executionAllowed(context: common.Context): boolean {
    try { BackupAccess.requireReady(context); return true; } catch (_error) { return false; }
  }
  static beginExecution(context: common.Context): BackupLease {
    if (BackupAccess.pending(context)) { throw new Error('备份恢复等待应用启动完成，当前任务未执行'); }
    const lease = BackupAccess.lock(context, false);
    // The journal can have been published immediately before this shared lock was acquired.
    if (BackupAccess.pending(context)) { lease.release(); throw new Error('备份恢复尚未完成，当前任务未执行'); }
    return lease;
  }
  static beginExclusive(context: common.Context): BackupLease { return BackupAccess.lock(context, true); }
  private static lock(context: common.Context, exclusive: boolean): BackupLease {
    const file = fileIo.openSync(context.filesDir + '/backup-activity.lock',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW);
    try {
      file.tryLock(exclusive);
      return new BackupLease(file);
    } catch (_error) {
      fileIo.closeSync(file);
      throw new Error('备份、恢复或其他任务正在使用本机数据，请稍后重试');
    }
  }
}
