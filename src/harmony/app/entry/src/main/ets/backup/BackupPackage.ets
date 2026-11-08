import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import statvfs from '@ohos.file.statvfs';
import { util } from '@kit.ArkTS';
import nativeBackup from 'libleobackup.so';
import { atomicWriteText } from '../store/AtomicFile';
import { BackupStore } from './BackupStore';
import { BackupDiskJournal } from './BackupDiskJournal';
import { BACKUP_CHUNK, BACKUP_ENTRY_LIMIT, BACKUP_TOTAL_LIMIT, backupCheck, backupCopy, backupFsyncDir, backupMkdir, backupRead, backupRemove, backupText, backupWrite } from './BackupFiles';
import { BACKUP_ROOT_FILES, BACKUP_TREE_DIRS, BackupFileRecord, backupSafeTreePath, backupTarget } from './BackupPaths';
import { BackupZipEntry, backupZipDirectory, backupZipExtract } from './BackupZip';

export class BackupProgress {
  stage: string = '';
  files: number = 0;
  bytes: number = 0;
  percent: number = -1;
}
export class BackupPackageManifest {
  format: string = 'leobot-harmony-backup';
  version: number = 2;
  createdAt: number = Date.now();
  files: number = 0;
  bytes: number = 0;
  indexSha256: string = '';
  credentialsIncluded: boolean = false;
}
export class BackupPackageResult {
  path: string = '';
  count: number = 0;
  bytes: number = 0;
}
export class BackupPackagePreview {
  directory: string = '';
  manifest: BackupPackageManifest = new BackupPackageManifest();
}

export class BackupPackage {
  private static nativeToken: string = '';
  static cancel(): void { if (BackupPackage.nativeToken) { nativeBackup.cancel(BackupPackage.nativeToken); } }

  static async create(context: common.Context, current: () => boolean, update: (state: BackupProgress) => void): Promise<BackupPackageResult> {
    const root = context.cacheDir + '/backup-export-' + util.generateRandomUUID(false);
    BackupStore.beginOperation(context);
    const output = root + '.leobak';
    const state = new BackupProgress(); state.stage = '正在扫描备份文件'; update(state);
    try {
      backupMkdir(root); backupMkdir(root + '/blobs');
      const paths = BackupPackage.inventory(context);
      let total = 0;
      for (const path of paths) { total += fileIo.lstatSync(backupTarget(context.filesDir, path, false)).size; }
      if (total > BACKUP_TOTAL_LIMIT || await statvfs.getFreeSize(context.cacheDir) < total * 2 + 32 * 1024 * 1024) { throw new Error('备份超过64GiB上限或空间不足，需要约两份备份大小的空闲空间'); }
      const index = fileIo.openSync(root + '/files.index.jsonl', fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      const manifest = new BackupPackageManifest();
      try {
        for (const path of paths) {
          backupCheck(current); state.stage = '正在保存文件快照';
          const temporary = root + '/snapshot-' + util.generateRandomUUID(false);
          const digest = await backupCopy(backupTarget(context.filesDir, path, false), temporary, current, (bytes: number) => { state.bytes += bytes; update(state); });
          const prefix = root + '/blobs/' + digest.sha256.slice(0, 2); backupMkdir(prefix);
          const blob = prefix + '/' + digest.sha256;
          if (fileIo.accessSync(blob)) { backupRemove(temporary); } else { fileIo.renameSync(temporary, blob); }
          const record = new BackupFileRecord(); record.path = path; record.size = digest.size; record.sha256 = digest.sha256;
          const bytes = new util.TextEncoder().encodeInto(JSON.stringify(record) + '\n');
          backupWrite(index.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          manifest.files++; manifest.bytes += digest.size; state.files = manifest.files; update(state);
        }
        fileIo.fsyncSync(index.fd);
      } finally { fileIo.closeSync(index); }
      manifest.indexSha256 = (await backupCopy(root + '/files.index.jsonl', '', current)).sha256;
      atomicWriteText(root + '/manifest.json', JSON.stringify(manifest));
      backupFsyncDir(root);
      backupCheck(current);
      state.stage = '正在封装标准ZIP'; state.percent = 0; update(state);
      const token = util.generateRandomUUID(false); BackupPackage.nativeToken = token;
      const timer = setInterval(() => {
        if (!current()) { nativeBackup.cancel(token); }
        state.percent = nativeBackup.progress(token); update(state);
      }, 100);
      try { await nativeBackup.pack(token, output, [root + '/manifest.json', root + '/files.index.jsonl', root + '/blobs']); }
      finally { clearInterval(timer); if (BackupPackage.nativeToken === token) { BackupPackage.nativeToken = ''; } }
      backupCheck(current); await backupZipDirectory(output, current);
      const result = new BackupPackageResult(); result.path = output; result.count = manifest.files; result.bytes = fileIo.lstatSync(output).size; return result;
    } catch (error) { backupRemove(output); throw error as Error; }
    finally { backupRemove(root); BackupStore.endOperation(); }
  }

  static async preview(context: common.Context, uri: string, current: () => boolean, update: (state: BackupProgress) => void): Promise<BackupPackagePreview> {
    const root = context.cacheDir + '/backup-import-' + util.generateRandomUUID(false);
    BackupStore.beginOperation(context);
    const state = new BackupProgress(); state.stage = '正在读取备份包'; update(state);
    try {
      backupMkdir(root); backupMkdir(root + '/package');
      await BackupPackage.copyDocument(uri, root + '/archive.zip', false, current, (bytes: number) => { state.bytes += bytes; update(state); });
      const entries = await backupZipDirectory(root + '/archive.zip', current);
      const expanded = entries.reduce((sum: number, entry: BackupZipEntry) => sum + entry.size, 0);
      if (await statvfs.getFreeSize(context.cacheDir) < expanded + 32 * 1024 * 1024) { throw new Error('解包备份的空闲空间不足'); }
      state.stage = '正在解包并增量校验'; state.bytes = 0; update(state);
      const hashes = await backupZipExtract(root + '/archive.zip', root + '/package', entries, current, (bytes: number) => { state.bytes += bytes; update(state); });
      const manifest = JSON.parse(backupText(root + '/package/manifest.json', 8 * 1024 * 1024)) as BackupPackageManifest;
      if (!manifest || manifest.format !== 'leobot-harmony-backup' || manifest.version !== 2 || !Number.isSafeInteger(manifest.files) ||
        manifest.files < 0 || manifest.files > BACKUP_ENTRY_LIMIT || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > BACKUP_TOTAL_LIMIT ||
        manifest.credentialsIncluded !== false || manifest.indexSha256 !== hashes.get('files.index.jsonl')) { throw new Error('备份清单格式或索引校验失败'); }
      const records = await BackupDiskJournal.readRecords(root + '/package/files.index.jsonl', current); let total = 0;
      for (const row of records) {
        backupCheck(current);
        const member = 'blobs/' + row.sha256.slice(0, 2) + '/' + row.sha256;
        const stat = fileIo.lstatSync(root + '/package/' + member);
        if (!row.existed || hashes.get(member) !== row.sha256 || stat.size !== row.size) { throw new Error('备份内容哈希或大小与索引不一致'); }
        total += row.size;
      }
      if (records.length !== manifest.files || total !== manifest.bytes) { throw new Error('备份文件数量或总大小不一致'); }
      for (const entry of entries) {
        if (!entry.directory && entry.name.startsWith('blobs/') && hashes.get(entry.name) !== entry.name.split('/').pop()) { throw new Error('备份包含损坏的内容寻址文件'); }
      }
      backupRemove(root + '/archive.zip');
      const preview = new BackupPackagePreview(); preview.directory = root; preview.manifest = manifest; return preview;
    } catch (error) { backupRemove(root); throw error as Error; }
    finally { BackupStore.endOperation(); }
  }

  static discard(context: common.Context, preview: BackupPackagePreview | null): void {
    if (preview && preview.directory.startsWith(context.cacheDir + '/backup-import-') && /^backup-import-[a-f0-9-]{36}$/.test(preview.directory.slice(context.cacheDir.length + 1))) { backupRemove(preview.directory); }
  }

  static async prepareRestore(context: common.Context, preview: BackupPackagePreview, current: () => boolean,
    update: (state: BackupProgress) => void): Promise<void> {
    const journal = new BackupDiskJournal(); journal.directory = 'restore-' + util.generateRandomUUID(false);
    const root = context.filesDir + '/' + journal.directory;
    BackupStore.beginOperation(context);
    let published = false;
    const state = new BackupProgress(); state.stage = '正在准备可回滚的恢复'; update(state);
    try {
      if (!preview.directory.startsWith(context.cacheDir + '/backup-import-') || !/^backup-import-[a-f0-9-]{36}$/.test(preview.directory.slice(context.cacheDir.length + 1))) { throw new Error('备份预览已失效'); }
      const records = await BackupDiskJournal.readRecords(preview.directory + '/package/files.index.jsonl', current);
      let needed = 0;
      for (const row of records) {
        const target = backupTarget(context.filesDir, row.path, false); needed += row.size;
        if (fileIo.accessSync(target)) { needed += fileIo.lstatSync(target).size; }
      }
      if (await statvfs.getFreeSize(context.filesDir) < needed + 32 * 1024 * 1024) { throw new Error('恢复和回滚快照所需空闲空间不足'); }
      backupMkdir(root); backupMkdir(root + '/before'); backupMkdir(root + '/after');
      const before: BackupFileRecord[] = [];
      for (const row of records) {
        backupCheck(current);
        if (!row.existed) { throw new Error('备份索引含无效删除记录'); }
        const blob = preview.directory + '/package/blobs/' + row.sha256.slice(0, 2) + '/' + row.sha256;
        if (!fileIo.accessSync(root + '/after/' + row.sha256)) {
          const copied = await backupCopy(blob, root + '/after/' + row.sha256, current);
          if (copied.sha256 !== row.sha256 || copied.size !== row.size) { throw new Error('恢复源文件在预览后发生变化'); }
        }
        const old = new BackupFileRecord(); old.path = row.path; old.existed = false; old.sha256 = row.sha256;
        const target = backupTarget(context.filesDir, row.path, false);
        if (fileIo.accessSync(target)) {
          const temporary = root + '/before/snapshot-' + util.generateRandomUUID(false);
          const copied = await backupCopy(target, temporary, current);
          old.existed = true; old.sha256 = copied.sha256; old.size = copied.size;
          const previous = root + '/before/' + copied.sha256;
          if (fileIo.accessSync(previous)) { backupRemove(temporary); } else { fileIo.renameSync(temporary, previous); }
        }
        before.push(old); state.files++; state.bytes += row.size; update(state);
      }
      await BackupPackage.writeIndex(root + '/before.index.jsonl', before, current);
      await BackupPackage.writeIndex(root + '/after.index.jsonl', records, current);
      backupFsyncDir(root + '/before'); backupFsyncDir(root + '/after'); backupFsyncDir(root); backupFsyncDir(context.filesDir);
      backupCheck(current);
      atomicWriteText(context.filesDir + '/restore-journal-v2.json', JSON.stringify(journal)); published = true;
    } finally {
      // A durability-uncertain pointer still owns its rollback snapshot.
      if (!published && !fileIo.accessSync(context.filesDir + '/restore-journal-v2.json')) { backupRemove(root); }
      BackupStore.endOperation();
    }
  }

  static async copyDocument(source: string, destination: string, exportFile: boolean, current: () => boolean,
    progress: (bytes: number) => void): Promise<void> {
    const input = fileIo.openSync(source, fileIo.OpenMode.READ_ONLY);
    let output: fileIo.File | null = null;
    try {
      let remaining = fileIo.statSync(input.fd).size;
      if (remaining > BACKUP_TOTAL_LIMIT + 1024 * 1024 * 1024) { throw new Error('备份文档超过大小上限'); }
      const root = destination.slice(0, destination.lastIndexOf('/'));
      if (!exportFile && await statvfs.getFreeSize(root) < remaining + 32 * 1024 * 1024) { throw new Error('读取备份文档所需空间不足'); }
      backupCheck(current);
      output = fileIo.openSync(destination, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | (exportFile ? 0 : fileIo.OpenMode.NOFOLLOW));
      while (remaining > 0) {
        backupCheck(current);
        const buffer = backupRead(input.fd, Math.min(BACKUP_CHUNK, remaining)); backupWrite(output.fd, buffer);
        remaining -= buffer.byteLength; progress(buffer.byteLength);
        await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
      }
      backupCheck(current); fileIo.fsyncSync(output.fd);
    } finally { fileIo.closeSync(input); if (output) { fileIo.closeSync(output); } }
  }

  private static inventory(context: common.Context): string[] {
    const output: string[] = [];
    const walk = (relative: string): void => {
      const absolute = context.filesDir + '/' + relative;
      if (!fileIo.accessSync(absolute)) { return; }
      const stat = fileIo.lstatSync(absolute);
      if (stat.isSymbolicLink()) { throw new Error('备份目录含不安全链接'); }
      if (stat.isDirectory()) {
        if (relative.split('/').length >= 32) { throw new Error('备份目录层级超过上限'); }
        for (const name of fileIo.listFileSync(absolute)) {
          const path = relative + '/' + name;
          if (backupSafeTreePath(path)) { walk(path); }
        }
      } else {
        if (!stat.isFile() || !backupSafeTreePath(relative)) { throw new Error('备份源含不受支持文件'); }
        if (output.length >= BACKUP_ENTRY_LIMIT) { throw new Error('备份文件数量超过上限'); }
        output.push(relative);
      }
    };
    for (const path of BACKUP_ROOT_FILES.concat(BACKUP_TREE_DIRS)) { walk(path); }
    return output;
  }
  private static async writeIndex(path: string, records: BackupFileRecord[], current: () => boolean): Promise<void> {
    const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try {
      for (const record of records) {
        backupCheck(current);
        const bytes = new util.TextEncoder().encodeInto(JSON.stringify(record) + '\n');
        backupWrite(file.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
      }
      fileIo.fsyncSync(file.fd);
    } finally { fileIo.closeSync(file); }
  }
}
