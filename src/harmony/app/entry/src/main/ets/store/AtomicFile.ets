import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

/** 已替换但后续刷盘失败：可见内容已改变，绝不能宣称持久成功或回滚。 */
export class AtomicCommitUncertainError extends Error {
  constructor() { super('配置已替换，但持久化确认失败；已重新读取，请检查后重试'); }
}

/** 写完且刷盘后才替换旧配置；短写/失败绝不截断原档案。每个写者独立临时名。 */
export function atomicWriteText(path: string, text: string): void {
  const tmp = `${path}.${util.generateRandomUUID(false)}.tmp`;
  const bytes = new util.TextEncoder().encodeInto(text);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let renamed = false;
  try {
    const file = fileIo.openSync(tmp,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    try {
      if (fileIo.writeSync(file.fd, data) !== data.byteLength) {
        throw new Error('配置写入不完整，原档案已保留');
      }
      fileIo.fsyncSync(file.fd);
    } finally {
      fileIo.closeSync(file);
    }
    fileIo.renameSync(tmp, path);
    renamed = true;
    const parent = fileIo.openSync(path.substring(0, path.lastIndexOf('/')),
      fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
    try { fileIo.fsyncSync(parent.fd); } finally { fileIo.closeSync(parent); }
  } catch (error) {
    if (renamed) throw new AtomicCommitUncertainError();
    throw error as Error;
  } finally {
    if (fileIo.accessSync(tmp)) {
      fileIo.unlinkSync(tmp);
    }
  }
}

/** 配置的读版本属于 store 实例；跨进程过期写显式报错，不覆盖别人的更新。 */
export class AtomicTextFile {
  private unreadable: Set<string> = new Set();
  private snapshots: Map<string, string | null> = new Map();

  read(path: string): string {
    const value = fileIo.accessSync(path) ? fileIo.readTextSync(path) : null;
    this.snapshots.set(path, value);
    this.unreadable.delete(path);
    return value ?? '';
  }

  write(path: string, text: string): void {
    // 锁独立文件：目标会被 rename 替换，直接锁目标 inode 不能串行后继写者。
    const lock = fileIo.openSync(path + '.lock',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW);
    try {
      lock.tryLock(true);
      if (this.unreadable.has(path)) throw new Error('配置状态不确定，请先重新加载');
      const current = fileIo.accessSync(path) ? fileIo.readTextSync(path) : null;
      const expected = this.snapshots.get(path) ?? null;
      if (current !== expected) throw new Error('配置已被另一进程更新，请重新加载后重试');
      try {
        atomicWriteText(path, text);
        this.snapshots.set(path, text);
      } catch (error) {
        if (error instanceof AtomicCommitUncertainError) {
          // 锁仍持有；记录实际可见版本以便同进程恢复，但原 durability 错误继续上抛。
          try { this.read(path); } catch (_readError) { this.unreadable.add(path); }
        }
        throw error as Error;
      }
    } finally {
      // 关闭句柄也释放系统锁，进程退出不会遗留永久锁。
      fileIo.closeSync(lock);
    }
  }
}
