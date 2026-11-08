import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';
import { BACKUP_ENTRY_LIMIT, BACKUP_TOTAL_LIMIT, backupCopy, backupFsyncDir, backupLines, backupMkdir, backupRemove, backupText } from './BackupFiles';
import { BackupFileRecord, backupParseRecord, backupTarget } from './BackupPaths';

export class BackupDiskJournal {
  version: number = 2;
  directory: string = '';
  phase: string = 'apply';

  static async readRecords(path: string, current: () => boolean = () => true): Promise<BackupFileRecord[]> {
    const records: BackupFileRecord[] = [];
    const seen = new Set<string>(); let bytes = 0;
    await backupLines(path, (line: string) => {
      const row = backupParseRecord(line);
      bytes += row.size;
      if (seen.has(row.path) || records.length >= BACKUP_ENTRY_LIMIT || bytes > BACKUP_TOTAL_LIMIT) { throw new Error('备份恢复索引重复或超过上限'); }
      seen.add(row.path); records.push(row);
    }, current);
    return records;
  }
  static async recover(context: common.Context): Promise<void> {
    const pointer = context.filesDir + '/restore-journal-v2.json';
    if (!fileIo.accessSync(pointer)) { return; }
    const journal = JSON.parse(backupText(pointer, 4096)) as BackupDiskJournal;
    if (!journal || journal.version !== 2 || !/^restore-[a-f0-9-]{36}$/.test(journal.directory) || !['apply', 'rollback'].includes(journal.phase)) { throw new Error('备份恢复日志损坏，原数据已保留'); }
    const root = context.filesDir + '/' + journal.directory;
    backupMkdir(root); backupMkdir(root + '/before'); backupMkdir(root + '/after');
    const before = await BackupDiskJournal.readRecords(root + '/before.index.jsonl');
    const after = await BackupDiskJournal.readRecords(root + '/after.index.jsonl');
    if (before.length !== after.length || before.some((row: BackupFileRecord, index: number) => row.path !== after[index].path)) { throw new Error('恢复覆盖集合与回滚集合不一致'); }
    // Check both snapshots before changing any live file. This is repeated after every interrupted launch.
    await BackupDiskJournal.checkFiles(root + '/before', before);
    await BackupDiskJournal.checkFiles(root + '/after', after);
    if (journal.phase === 'apply') {
      try {
        await BackupDiskJournal.apply(context, root + '/after', after);
        fileIo.unlinkSync(pointer); backupFsyncDir(context.filesDir); backupRemove(root); return;
      } catch (_error) {
        journal.phase = 'rollback'; atomicWriteText(pointer, JSON.stringify(journal));
      }
    }
    await BackupDiskJournal.apply(context, root + '/before', before);
    fileIo.unlinkSync(pointer); backupFsyncDir(context.filesDir); backupRemove(root);
    throw new Error('恢复失败，原数据已回滚');
  }
  private static async checkFiles(root: string, rows: BackupFileRecord[]): Promise<void> {
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (!row.existed) { continue; }
      if (seen.has(row.sha256)) {
        if (seen.get(row.sha256) !== row.size) { throw new Error('恢复快照相同哈希的长度不一致'); }
        continue;
      }
      const result = await backupCopy(root + '/' + row.sha256, '', () => true);
      if (result.sha256 !== row.sha256 || result.size !== row.size) { throw new Error('恢复快照校验失败，保留日志并停止加载'); }
      seen.set(row.sha256, row.size);
    }
  }
  private static async apply(context: common.Context, root: string, rows: BackupFileRecord[]): Promise<void> {
    for (const row of rows) {
      const target = backupTarget(context.filesDir, row.path);
      if (!row.existed) { if (fileIo.accessSync(target)) { fileIo.unlinkSync(target); backupFsyncDir(target.slice(0, target.lastIndexOf('/'))); } continue; }
      const temporary = target + '.' + util.generateRandomUUID(false) + '.tmp';
      try {
        const copy = await backupCopy(root + '/' + row.sha256, temporary, () => true);
        if (copy.sha256 !== row.sha256 || copy.size !== row.size) { throw new Error('恢复复制校验失败'); }
        // Recheck every ancestor after the await and before the atomic replacement.
        backupTarget(context.filesDir, row.path);
        fileIo.renameSync(temporary, target); backupFsyncDir(target.slice(0, target.lastIndexOf('/')));
      } finally { backupRemove(temporary); }
    }
  }
}
