import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from './AtomicFile';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import nativeLinux from 'libleolinux.so';

export class WorkspaceFile {
  name: string = '';
  path: string = '';
  directory: boolean = false;
  size: number = 0;
  modified: number = 0;
}
export class WorkspacePreview { text: string = ''; truncated: boolean = false; }
export class WorkspaceTextWindow {
  lines: string[] = [];
  showStart: number = 1;
  totalLines: number = 1;
  size: number = 0;
}
class WorkspaceParent {
  directory: fileIo.File;
  leaf: string;
  constructor(directory: fileIo.File, leaf: string) { this.directory = directory; this.leaf = leaf; }
  path(): string { return '/proc/self/fd/' + this.directory.fd + '/' + this.leaf; }
}

export class WorkspaceStore {
  static list(context: common.Context, relative: string = ''): WorkspaceFile[] {
    const directory = WorkspaceStore.openDirectory(context, relative);
    try {
      const path = '/proc/self/fd/' + directory.fd;
      const names = fileIo.listFileSync(path);
      const rows: WorkspaceFile[] = [];
      for (const name of names) {
        try {
          const info = fileIo.lstatSync(path + '/' + name);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
          const row = new WorkspaceFile();
          row.name = name; row.path = (relative ? WorkspaceStore.safeName(relative) + '/' : '') + name;
          row.directory = info.isDirectory(); row.size = info.size; row.modified = info.mtime;
          rows.push(row);
        } catch (_error) { /* A concurrently removed entry is absent from this listing. */ }
      }
      return rows;
    } finally { fileIo.closeSync(directory); }
  }

  /** Every ancestor is opened relative to a pinned directory, with no symlink following. */
  static open(context: common.Context, name: string): fileIo.File {
    const parent = WorkspaceStore.parent(context, name);
    try {
      const path = parent.path();
      WorkspaceStore.rejectLink(path);
      if (!fileIo.accessSync(path)) throw new Error('工作区里没有这个文件');
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      if (!fileIo.statSync(file.fd).isFile()) { fileIo.closeSync(file); throw new Error('请选择普通文件'); }
      return file;
    } finally { fileIo.closeSync(parent.directory); }
  }

  static read(context: common.Context, name: string): string {
    const file = WorkspaceStore.open(context, name);
    try {
      if (fileIo.statSync(file.fd).size > 16 * 1024 * 1024) throw new Error('完整文本读取上限16MB，请使用file_read分页或Linux命令处理这个文件');
      const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
      const chunks: string[] = [];
      const buffer = new ArrayBuffer(64 * 1024);
      let length = 0;
      for (;;) {
        const count = fileIo.readSync(file.fd, buffer);
        if (!count) break;
        length += count;
        if (length > 16 * 1024 * 1024) throw new Error('文件超过完整读取上限，请使用file_read分页');
        chunks.push(decoder.decodeToString(new Uint8Array(buffer, 0, count), { stream: true }));
      }
      chunks.push(decoder.decodeToString(new Uint8Array(), { stream: false }));
      return chunks.join('');
    } finally { fileIo.closeSync(file); }
  }

  /** Two bounded passes retain the existing line-count and head/tail pagination contract. */
  static async readWindow(context: common.Context, name: string, offset: number, requested: number,
    hasLineLimit: boolean, maxLength: number, direction: string, isCurrent: () => boolean): Promise<WorkspaceTextWindow> {
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(requested) || requested < 0 || !Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error('文件分页参数需为有效整数');
    if (direction !== 'head' && direction !== 'tail') throw new Error('文件读取方向需为head或tail');
    const file = WorkspaceStore.open(context, name);
    try {
      const before = fileIo.statSync(file.fd);
      const result = new WorkspaceTextWindow(); result.size = before.size;
      await WorkspaceStore.scan(file.fd, (text: string): boolean => {
        let at = text.indexOf('\n');
        while (at >= 0) { result.totalLines++; at = text.indexOf('\n', at + 1); }
        return true;
      }, isCurrent, before.size);
      const count = hasLineLimit ? requested : result.totalLines;
      const start = direction === 'tail' ? Math.max(1, result.totalLines - count + 1) : offset;
      const end = Math.min(result.totalLines, start + count - 1);
      result.showStart = start;
      const cap = Math.min(80000, maxLength);
      let line = 1;
      let pending = '';
      let used = 0;
      let stopped = false;
      if (start <= end) {
        await WorkspaceStore.scan(file.fd, (text: string): boolean => {
          let cursor = 0;
          while (cursor < text.length) {
            const newline = text.indexOf('\n', cursor);
            const boundary = newline < 0 ? text.length : newline;
            if (line >= start && line <= end) {
              const limit = cap + 1 - used - (result.lines.length ? 1 : 0);
              pending += text.substring(cursor, Math.min(boundary, cursor + Math.max(0, limit - pending.length)));
              if (used + (result.lines.length ? 1 : 0) + pending.length > cap) {
                result.lines.push(pending); stopped = true; return false;
              }
            }
            if (newline < 0) return true;
            if (line >= start && line <= end) {
              used += (result.lines.length ? 1 : 0) + pending.length;
              result.lines.push(pending); pending = '';
            }
            line++;
            if (line > end) { stopped = true; return false; }
            cursor = boundary + 1;
          }
          return true;
        }, isCurrent, before.size);
        if (!stopped && line >= start && line <= end) result.lines.push(pending);
      }
      const after = fileIo.statSync(file.fd);
      if (after.size !== before.size || after.mtime !== before.mtime) throw new Error('文件在读取时发生变化，请重试');
      return result;
    } finally { fileIo.closeSync(file); }
  }

  private static async scan(fd: number, consume: (text: string) => boolean, isCurrent: () => boolean, length: number): Promise<void> {
    fileIo.lseek(fd, 0, fileIo.WhenceType.SEEK_SET);
    const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
    const buffer = new ArrayBuffer(1024 * 1024);
    for (;;) {
      if (!isCurrent()) throw new Error('文件读取已取消');
      if (!length) { consume(decoder.decodeToString(new Uint8Array(), { stream: false })); return; }
      const chunk = length < buffer.byteLength ? new ArrayBuffer(length) : buffer;
      const count = fileIo.readSync(fd, chunk);
      if (!count) throw new Error('文件在读取时被截断，请重试');
      length -= count;
      if (!consume(decoder.decodeToString(new Uint8Array(chunk, 0, count), { stream: true }))) return;
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
    }
  }

  static write(context: common.Context, name: string, text: string): void {
    const parent = WorkspaceStore.parent(context, name, true);
    try { WorkspaceStore.rejectLink(parent.path()); atomicWriteText(parent.path(), text, parent.directory.fd); }
    finally { fileIo.closeSync(parent.directory); }
  }

  static createDirectory(context: common.Context, name: string): void {
    const parent = WorkspaceStore.parent(context, name, true);
    try {
      if (fileIo.accessSync(parent.path())) throw new Error('已有同名文件或文件夹');
      fileIo.mkdirSync(parent.path()); fileIo.fsyncSync(parent.directory.fd);
    } finally { fileIo.closeSync(parent.directory); }
  }

  /** Legacy flat-path API. Data consumers use open() to pin nested ancestors. */
  static pathOf(context: common.Context, name: string): string {
    const safe = WorkspaceStore.safeName(name);
    if (safe.includes('/')) throw new Error('嵌套文件请使用工作区文件句柄');
    const root = WorkspaceStore.openDirectory(context);
    try { WorkspaceStore.rejectLink('/proc/self/fd/' + root.fd + '/' + safe); }
    finally { fileIo.closeSync(root); }
    return context.filesDir + '/workspace/' + safe;
  }

  static preview(context: common.Context, name: string): WorkspacePreview {
    const file = WorkspaceStore.open(context, name);
    try {
      const info = fileIo.statSync(file.fd);
      const bytes = new ArrayBuffer(Math.min(info.size, 128 * 1024));
      let length = 0;
      while (length < bytes.byteLength) {
        const chunk = new ArrayBuffer(bytes.byteLength - length);
        const count = fileIo.readSync(file.fd, chunk);
        if (!count) break;
        new Uint8Array(bytes).set(new Uint8Array(chunk, 0, count), length); length += count;
      }
      const result = new WorkspacePreview(); result.truncated = info.size > length;
      result.text = util.TextDecoder.create('utf-8', { ignoreBOM: true })
        .decodeToString(new Uint8Array(bytes, 0, length), { stream: result.truncated });
      if (result.text.includes('\u0000')) throw new Error('此文件使用二进制格式，可导出后查看');
      return result;
    } finally { fileIo.closeSync(file); }
  }

  static async exportTo(context: common.Context, name: string, uri: string): Promise<void> {
    const source = WorkspaceStore.open(context, name);
    try {
      const destination = fileIo.openSync(uri, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE);
      try {
        if (fileIo.statSync(destination.fd).ino === fileIo.statSync(source.fd).ino) throw new Error('请选择工作区以外的导出位置');
        await fileIo.copyFile(source.fd, destination.fd); fileIo.fsyncSync(destination.fd);
      } finally { fileIo.closeSync(destination); }
    } finally { fileIo.closeSync(source); }
  }

  /** Exclusive creation preserves earlier attachments when uploads choose the same name concurrently. */
  static saveUpload(context: common.Context, original: string, bytes: ArrayBuffer, directory: string = ''): string {
    const root = WorkspaceStore.openDirectory(context, directory);
    const clean = original.replace(/[\\/\x00-\x1f\x7f]+/g, '_').replace(/^\.+/, '').trim() || `附件-${Date.now()}`;
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.substring(0, dot) : clean;
    const ext = dot > 0 ? clean.substring(dot) : '';
    let fd: number = -1;
    let name = clean;
    try {
      for (let suffix = 1; fd < 0; suffix++) {
        name = suffix === 1 ? clean : stem + '-' + suffix + ext;
        fd = nativeLinux.createWorkspaceFile(root.fd, name);
        if (fd < 0 && fd !== -17) throw new Error('附件创建失败（' + (-fd) + '）');
      }
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = fileIo.writeSync(fd, bytes.slice(offset));
          if (count <= 0) throw new Error('附件写入不完整');
          offset += count;
        }
        fileIo.fsyncSync(fd);
      } catch (error) {
        const target = '/proc/self/fd/' + root.fd + '/' + name;
        if (fileIo.accessSync(target) && fileIo.lstatSync(target).ino === fileIo.statSync(fd).ino) fileIo.unlinkSync(target);
        throw error as Error;
      } finally { fileIo.closeSync(fd); }
      fileIo.fsyncSync(root.fd);
      return (directory ? WorkspaceStore.safeName(directory) + '/' : '') + name;
    } finally { fileIo.closeSync(root); }
  }

  private static safeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 4096 || /[\\\x00-\x1f\x7f]/.test(trimmed) || trimmed.startsWith('/') || trimmed.split('/').some((part: string) => !part || part === '.' || part === '..')) throw new Error('只允许工作区内的相对文件路径');
    return trimmed;
  }
  private static parent(context: common.Context, name: string, create: boolean = false): WorkspaceParent {
    const parts = WorkspaceStore.safeName(name).split('/');
    const leaf = parts.pop() as string;
    return new WorkspaceParent(WorkspaceStore.openDirectory(context, parts.join('/'), create), leaf);
  }
  private static openDirectory(context: common.Context, relative: string = '', create: boolean = false): fileIo.File {
    const root = context.filesDir + '/workspace';
    if (!fileIo.accessSync(root)) fileIo.mkdirSync(root);
    const info = fileIo.lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工作区目录无效或为符号链接');
    let directory = fileIo.openSync(root, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
    try {
      const parts = relative ? WorkspaceStore.safeName(relative).split('/') : [];
      for (const part of parts) {
        const path = '/proc/self/fd/' + directory.fd + '/' + part;
        if (create && !fileIo.accessSync(path)) { fileIo.mkdirSync(path); fileIo.fsyncSync(directory.fd); }
        WorkspaceStore.rejectLink(path);
        const child = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
        fileIo.closeSync(directory); directory = child;
      }
      return directory;
    } catch (error) { fileIo.closeSync(directory); throw error as Error; }
  }
  private static rejectLink(path: string): void {
    let info: fileIo.Stat;
    try { info = fileIo.lstatSync(path); }
    catch (error) { if ((error as BusinessError).code === 13900002) return; throw error as Error; }
    if (info.isSymbolicLink()) throw new Error('工作区不允许通过符号链接访问文件');
  }
}
