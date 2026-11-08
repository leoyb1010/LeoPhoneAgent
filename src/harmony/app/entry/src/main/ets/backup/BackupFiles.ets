import { fileIo } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

export const BACKUP_CHUNK: number = 1024 * 1024;
export const BACKUP_TOTAL_LIMIT: number = 64 * 1024 * 1024 * 1024;
export const BACKUP_ENTRY_LIMIT: number = 400000;
export class BackupDigest { sha256: string = ''; size: number = 0; }

export function backupCheck(current: () => boolean): void {
  if (!current()) { throw new Error('备份操作已取消'); }
}
export function backupRead(fd: number, length: number, position: number = -1): ArrayBuffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > BACKUP_CHUNK) { throw new Error('备份读取块超限'); }
  if (position >= 0) { fileIo.lseek(fd, position, fileIo.WhenceType.SEEK_SET); }
  const buffer = new ArrayBuffer(length);
  let read = 0;
  while (read < length) {
    const part = new ArrayBuffer(length - read);
    const count = fileIo.readSync(fd, part);
    if (count <= 0) { throw new Error('备份文件被截断'); }
    new Uint8Array(buffer).set(new Uint8Array(part, 0, count), read); read += count;
  }
  return buffer;
}
export function backupWrite(fd: number, buffer: ArrayBuffer): void {
  let written = 0;
  while (written < buffer.byteLength) {
    const count = fileIo.writeSync(fd, buffer.slice(written));
    if (count <= 0) { throw new Error('备份写入不完整'); }
    written += count;
  }
}
export function backupFsyncDir(path: string): void {
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
  try { fileIo.fsyncSync(file.fd); } finally { fileIo.closeSync(file); }
}
export function backupMkdir(path: string): void {
  if (!fileIo.accessSync(path)) { fileIo.mkdirSync(path); }
  const stat = fileIo.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('备份目录含不安全链接'); }
}
export function backupRemove(path: string): void {
  if (!fileIo.accessSync(path)) { return; }
  const stat = fileIo.lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) { fileIo.rmdirSync(path); }
  else { fileIo.unlinkSync(path); }
}
export function backupHex(bytes: Uint8Array): string {
  let result = '';
  for (const value of bytes) { result += value.toString(16).padStart(2, '0'); }
  return result;
}
/** Copy and hash at most one MiB per turn. Never follows a source or destination symlink. */
export async function backupCopy(source: string, target: string, current: () => boolean,
  onBytes: (bytes: number) => void = () => {}): Promise<BackupDigest> {
  const before = fileIo.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > BACKUP_TOTAL_LIMIT) { throw new Error('备份源文件不安全或过大'); }
  const input = fileIo.openSync(source, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
  let output: fileIo.File | null = null;
  const digest = cryptoFramework.createMd('SHA256');
  try {
    if (target) {
      if (fileIo.accessSync(target)) { throw new Error('备份临时目标已存在'); }
      output = fileIo.openSync(target, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    }
    let remaining = before.size;
    while (remaining > 0) {
      backupCheck(current);
      const buffer = backupRead(input.fd, Math.min(BACKUP_CHUNK, remaining));
      await digest.update({ data: new Uint8Array(buffer) });
      if (output) { backupWrite(output.fd, buffer); }
      remaining -= buffer.byteLength; onBytes(buffer.byteLength);
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
    }
    backupCheck(current);
    const after = fileIo.statSync(input.fd);
    if (after.size !== before.size || after.mtime !== before.mtime) { throw new Error('备份期间文件发生变化，请重试'); }
    if (output) { fileIo.fsyncSync(output.fd); }
    const result = new BackupDigest(); result.size = before.size; result.sha256 = backupHex((await digest.digest()).data); return result;
  } finally { fileIo.closeSync(input); if (output) { fileIo.closeSync(output); } }
}
export function backupText(path: string, maxBytes: number): string {
  const stat = fileIo.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) { throw new Error('备份元数据过大或不安全'); }
  return fileIo.readTextSync(path);
}
export async function backupLines(path: string, visit: (line: string) => void, current: () => boolean): Promise<void> {
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
  const decoder = util.TextDecoder.create('utf-8', { fatal: true });
  let pending = '';
  try {
    let remaining = fileIo.statSync(file.fd).size;
    while (remaining > 0) {
      backupCheck(current);
      const bytes = backupRead(file.fd, Math.min(65536, remaining)); remaining -= bytes.byteLength;
      pending += decoder.decodeToString(new Uint8Array(bytes), { stream: remaining > 0 });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (line.length > 65536) { throw new Error('备份索引单行过大'); }
        if (line) { visit(line); }
        newline = pending.indexOf('\n');
      }
      if (pending.length > 65536) { throw new Error('备份索引单行过大'); }
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
    }
    if (pending) { throw new Error('备份索引末行不完整'); }
  } finally { fileIo.closeSync(file); }
}
