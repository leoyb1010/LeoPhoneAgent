import { BackupAccess, BackupLease } from './BackupAccess';
import { BackupDiskJournal } from './BackupDiskJournal';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { atomicWriteText } from '../store/AtomicFile';
import { ChatRuns } from '../local/ChatRun';
import { taskStatus } from '../store/TaskStatus';

export class BackupEntry {
  path: string = '';
  data: string = '';
  sha256: string = '';
  size: number = 0;
}

export class BackupArchive {
  format: string = 'leobot-harmony-backup';
  version: number = 1;
  createdAt: number = Date.now();
  entries: BackupEntry[] = [];
}

class RestoreJournal {
  before: BackupEntry[] = [];
  created: string[] = [];
  replacement: BackupEntry[] = [];
}

const ROOT_FILES: string[] = ['providers.json', 'mcp.json', 'env.json', 'skills.json', 'SOUL.md',
  'collections.json', 'schedule.json', 'body.json', 'usage.json', 'sync-config-ids.json',
  'chat-drafts.json', 'sync-file-index.json', 'sync-artifact-heads.json', 'sync-collection-session.json', 'sync-disabled-destinations.json'];
const DIRECTORIES: string[] = ['sessions', 'chat-images', 'workspace', 'memory', 'schedule-claims'];
const LIMIT: number = 96 * 1024 * 1024;

export class BackupStore {
  private static busy: boolean = false;
  private static operationLease: BackupLease | null = null;
  private static recovery: Map<string, Promise<void>> = new Map();

  static safePath(path: string): boolean {
    if (!path || path.length > 512 || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return false;
    const parts = path.split('/');
    if (parts.some((part: string) => !part || part === '.' || part === '..')) return false;
    return (parts.length === 1 && ROOT_FILES.indexOf(path) >= 0) ||
      (parts.length === 2 && DIRECTORIES.indexOf(parts[0]) >= 0 && !parts[1].endsWith('.lock') && !parts[1].endsWith('.tmp'));
  }

  static async create(context: common.Context): Promise<BackupArchive> {
    BackupStore.assertIdle();
    const archive = new BackupArchive();
    const paths = ROOT_FILES.slice();
    for (let i = 0; i < DIRECTORIES.length; i++) {
      const dir = `${context.filesDir}/${DIRECTORIES[i]}`;
      if (!fileIo.accessSync(dir)) continue;
      const stat = fileIo.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份目录存在不安全链接');
      const names = fileIo.listFileSync(dir);
      for (let j = 0; j < names.length; j++) {
        const path = `${DIRECTORIES[i]}/${names[j]}`;
        if (BackupStore.safePath(path)) paths.push(path);
      }
    }
    let size = 0;
    for (let i = 0; i < paths.length; i++) {
      const absolute = `${context.filesDir}/${paths[i]}`;
      if (!fileIo.accessSync(absolute)) continue;
      const entry = await BackupStore.readEntry(absolute, paths[i]);
      size += entry.size;
      if (size > LIMIT) throw new Error('当前本机备份上限为 96 MB，请先导出大型附件');
      archive.entries.push(entry);
    }
    return archive;
  }

  static async validate(raw: string): Promise<BackupArchive> {
    if (raw.length > LIMIT * 1.5) throw new Error('备份超过大小限制');
    const archive = JSON.parse(raw) as BackupArchive;
    if (!archive || archive.format !== 'leobot-harmony-backup' || archive.version !== 1 || !Array.isArray(archive.entries)) {
      throw new Error('不是受支持的 LeoBot 鸿蒙备份');
    }
    if (archive.entries.length > 10000) throw new Error('备份文件数量超过限制');
    const seen: string[] = [];
    let total = 0;
    for (let i = 0; i < archive.entries.length; i++) {
      const entry = archive.entries[i];
      if (!entry || typeof entry.path !== 'string' || !BackupStore.safePath(entry.path) || seen.indexOf(entry.path) >= 0 ||
        typeof entry.data !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LIMIT || entry.data.length > LIMIT * 1.5) {
        throw new Error('备份含不安全路径或无效内容');
      }
      seen.push(entry.path); total += entry.size;
      if (total > LIMIT) throw new Error('备份解码后超过大小限制');
      const bytes = new util.Base64Helper().decodeSync(entry.data);
      if (bytes.byteLength !== entry.size || await BackupStore.hash(bytes) !== entry.sha256) throw new Error(`备份校验失败：${entry.path}`);
    }
    return archive;
  }

  static async restore(context: common.Context, raw: string): Promise<void> {
    BackupStore.beginOperation(context);
    try {
      const archive = await BackupStore.validate(raw);
      const journal = new RestoreJournal();
      for (let i = 0; i < archive.entries.length; i++) {
        const entry = archive.entries[i];
        BackupStore.assertTarget(context, entry.path);
        const absolute = `${context.filesDir}/${entry.path}`;
        if (fileIo.accessSync(absolute)) journal.before.push(await BackupStore.readEntry(absolute, entry.path));
        else journal.created.push(entry.path);
      }
      journal.replacement = archive.entries;
      atomicWriteText(`${context.filesDir}/restore-journal.json`, JSON.stringify(journal));
    } finally { BackupStore.endOperation(); }
  }

  /** 必须在启动加载任何 Store 前调用，恢复中断时回滚完整覆盖集合。 */
  static recover(context: common.Context): void {
    const journalPath = `${context.filesDir}/restore-journal.json`;
    if (!fileIo.accessSync(journalPath)) return;
    const journal = JSON.parse(fileIo.readTextSync(journalPath)) as RestoreJournal;
    if (!Array.isArray(journal.before) || !Array.isArray(journal.created)) throw new Error('恢复日志损坏，需要保留本机数据排查');
    if (Array.isArray(journal.replacement)) {
      try {
        for (let i = 0; i < journal.replacement.length; i++) BackupStore.writeEntry(context, journal.replacement[i]);
        fileIo.unlinkSync(journalPath);
        const directory = fileIo.openSync(context.filesDir, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR);
        try { fileIo.fsyncSync(directory.fd); } finally { fileIo.closeSync(directory); }
        return;
      } catch (_error) {
        // 启动时独占恢复，失败则用完整旧快照回滚。
      }
    }
    for (let i = 0; i < journal.before.length; i++) {
      if (!BackupStore.safePath(journal.before[i].path)) throw new Error('恢复日志路径不安全');
      BackupStore.writeEntry(context, journal.before[i]);
    }
    for (let i = 0; i < journal.created.length; i++) {
      const path = journal.created[i]; BackupStore.assertTarget(context, path);
      if (fileIo.accessSync(`${context.filesDir}/${path}`)) fileIo.unlinkSync(`${context.filesDir}/${path}`);
    }
    fileIo.unlinkSync(journalPath);
    throw new Error('恢复失败，原数据已回滚');
  }

  static executionAllowed(context: common.Context): boolean { return !BackupStore.busy && BackupAccess.executionAllowed(context); }
  static requireReady(context: common.Context): void {
    if (BackupStore.busy) { throw new Error('备份或恢复正在处理本机数据，当前任务未执行'); }
    BackupAccess.requireReady(context);
  }
  static beginExecution(context: common.Context): BackupLease {
    BackupStore.requireReady(context);
    return BackupAccess.beginExecution(context);
  }

  static beginOperation(context: common.Context): void {
    BackupStore.assertIdle();
    const lease = BackupAccess.beginExclusive(context);
    if (BackupAccess.pending(context)) { lease.release(); throw new Error('已有恢复等待重新启动，请先关闭并重新打开应用'); }
    BackupStore.operationLease = lease; BackupStore.busy = true;
  }

  static endOperation(): void {
    const lease = BackupStore.operationLease; BackupStore.operationLease = null;
    BackupStore.busy = false; lease?.release();
  }

  static recoverAsync(context: common.Context): Promise<void> {
    const existing = BackupStore.recovery.get(context.filesDir);
    if (existing) { return existing; }
    const work = Promise.resolve().then(async () => {
      if (BackupStore.busy) { throw new Error('备份或恢复正在处理本机数据'); }
      if (!BackupAccess.pending(context)) { BackupAccess.requireReady(context); return; }
      const lease = BackupAccess.beginExclusive(context); BackupStore.busy = true;
      try {
        if (fileIo.accessSync(context.filesDir + '/restore-journal.json') && fileIo.accessSync(context.filesDir + '/restore-journal-v2.json')) {
          throw new Error('存在冲突的恢复日志，数据已保留');
        }
        BackupStore.recover(context);
        await BackupDiskJournal.recover(context);
      } finally { BackupStore.busy = false; lease.release(); }
    });
    BackupStore.recovery.set(context.filesDir, work);
    work.then(() => { BackupStore.recovery.delete(context.filesDir); }, () => { BackupStore.recovery.delete(context.filesDir); });
    return work;
  }

  private static assertIdle(): void {
    if (BackupStore.busy || ChatRuns.anyActive() || taskStatus.running || taskStatus.pendingWrite) throw new Error('请先停止运行中和等待审批的任务，再备份或恢复');
  }

  private static assertTarget(context: common.Context, path: string): void {
    if (!BackupStore.safePath(path)) throw new Error('恢复路径不安全');
    const parts = path.split('/');
    if (parts.length === 2) {
      const dir = `${context.filesDir}/${parts[0]}`;
      if (!fileIo.accessSync(dir)) fileIo.mkdirSync(dir);
      const stat = fileIo.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('恢复目录不安全');
    }
    const target = `${context.filesDir}/${path}`;
    if (fileIo.accessSync(target)) {
      const stat = fileIo.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('恢复目标不安全');
    }
  }

  private static async hash(bytes: Uint8Array): Promise<string> {
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: bytes });
    const blob = await digest.digest();
    let result = '';
    for (let i = 0; i < blob.data.length; i++) result += blob.data[i].toString(16).padStart(2, '0');
    return result;
  }

  private static async readEntry(absolute: string, relative: string): Promise<BackupEntry> {
    const stat = fileIo.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error('备份文件不安全或过大');
    const file = fileIo.openSync(absolute, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
    const buffer = new ArrayBuffer(stat.size);
    try { if (fileIo.readSync(file.fd, buffer) !== stat.size) throw new Error('备份读取不完整'); }
    finally { fileIo.closeSync(file); }
    const entry = new BackupEntry(); entry.path = relative; entry.size = stat.size;
    entry.data = new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer));
    entry.sha256 = await BackupStore.hash(new Uint8Array(buffer)); return entry;
  }

  private static writeEntry(context: common.Context, entry: BackupEntry): void {
    BackupStore.assertTarget(context, entry.path);
    const bytes = new util.Base64Helper().decodeSync(entry.data);
    const temporary = `${context.filesDir}/${entry.path}.${util.generateRandomUUID()}.tmp`;
    const file = fileIo.openSync(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    try {
      if (fileIo.writeSync(file.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) !== bytes.byteLength) throw new Error('恢复写入不完整');
      fileIo.fsyncSync(file.fd);
    } finally { fileIo.closeSync(file); }
    fileIo.renameSync(temporary, `${context.filesDir}/${entry.path}`);
    const parent = `${context.filesDir}/${entry.path}`.replace(/\/[^/]+$/, '');
    const directory = fileIo.openSync(parent, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR);
    try { fileIo.fsyncSync(directory.fd); } finally { fileIo.closeSync(directory); }
  }
}
