import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BACKUP_CHUNK, BACKUP_ENTRY_LIMIT, BACKUP_TOTAL_LIMIT, backupCheck, backupHex, backupMkdir, backupRead, backupWrite } from './BackupFiles';

export class BackupZipEntry {
  name: string = '';
  size: number = 0;
  offset: number = 0;
  dataOffset: number = 0;
  crc: number = 0;
  directory: boolean = false;
}
function u16(bytes: ArrayBuffer, offset: number): number { return new DataView(bytes).getUint16(offset, true); }
function u32(bytes: ArrayBuffer, offset: number): number { return new DataView(bytes).getUint32(offset, true); }
function u64(bytes: ArrayBuffer, offset: number): number {
  const result = u32(bytes, offset) + u32(bytes, offset + 4) * 4294967296;
  if (!Number.isSafeInteger(result) || result > BACKUP_TOTAL_LIMIT + 1024 * 1024 * 1024) { throw new Error('ZIP64数值超过安全上限'); }
  return result;
}
function memberName(bytes: ArrayBuffer): string {
  const text = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(bytes));
  if (text === 'manifest.json' || text === 'files.index.jsonl' || text === 'blobs/' ||
    /^blobs\/[a-f0-9]{2}\/$/.test(text) || /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(text)) { return text; }
  throw new Error('备份ZIP含不受支持或不安全的成员路径');
}
/** Read the directory before touching output. Only content-addressed STORED members are accepted. */
export async function backupZipDirectory(path: string, current: () => boolean = () => true): Promise<BackupZipEntry[]> {
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
  try {
    const length = fileIo.statSync(file.fd).size;
    if (length < 22 || length > BACKUP_TOTAL_LIMIT + 1024 * 1024 * 1024) { throw new Error('备份ZIP大小无效'); }
    const tailStart = Math.max(0, length - 65557);
    const tail = backupRead(file.fd, length - tailStart, tailStart);
    let end = tail.byteLength - 22;
    while (end >= 0 && !(u32(tail, end) === 0x06054b50 && end + 22 + u16(tail, end + 20) === tail.byteLength)) { end--; }
    if (end < 0 || u16(tail, end + 4) !== 0 || u16(tail, end + 6) !== 0) { throw new Error('备份ZIP目录损坏或为分卷'); }
    let count = u16(tail, end + 10), centralSize = u32(tail, end + 12), centralStart = u32(tail, end + 16);
    if (u16(tail, end + 8) !== count) { throw new Error('备份ZIP条目数量不一致'); }
    let centralEndLimit = tailStart + end;
    if (count === 65535 || centralSize === 4294967295 || centralStart === 4294967295) {
      const locatorPosition = tailStart + end - 20;
      if (locatorPosition < 0) { throw new Error('ZIP64目录缺失'); }
      const locator = backupRead(file.fd, 20, locatorPosition);
      if (u32(locator, 0) !== 0x07064b50 || u32(locator, 4) !== 0 || u32(locator, 16) !== 1) { throw new Error('ZIP64定位信息损坏'); }
      const position = u64(locator, 8);
      if (position + 56 > locatorPosition) { throw new Error('ZIP64目录越界'); }
      const record = backupRead(file.fd, 56, position);
      if (u32(record, 0) !== 0x06064b50 || u64(record, 4) !== 44 || u32(record, 16) !== 0 || u32(record, 20) !== 0 || u64(record, 24) !== u64(record, 32)) { throw new Error('ZIP64目录不一致'); }
      count = u64(record, 32); centralSize = u64(record, 40); centralStart = u64(record, 48); centralEndLimit = position;
    }
    if (count > BACKUP_ENTRY_LIMIT || centralStart + centralSize > centralEndLimit) { throw new Error('备份ZIP目录超出上限'); }
    const entries: BackupZipEntry[] = [];
    const seen = new Set<string>();
    let offset = centralStart, total = 0;
    for (let i = 0; i < count; i++) {
      backupCheck(current);
      if (i % 128 === 0) { await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); }); }
      if (offset + 46 > centralStart + centralSize) { throw new Error('备份ZIP目录被截断'); }
      const header = backupRead(file.fd, 46, offset);
      if (u32(header, 0) !== 0x02014b50 || u16(header, 10) !== 0 || (u16(header, 8) & ~0x0800) !== 0 || u16(header, 34) !== 0) { throw new Error('备份ZIP压缩方式、加密或分卷标志不受支持'); }
      const nameLength = u16(header, 28), extraLength = u16(header, 30), commentLength = u16(header, 32);
      const endOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || nameLength > 1024 || endOffset > centralStart + centralSize) { throw new Error('备份ZIP成员名无效'); }
      const entry = new BackupZipEntry(); entry.name = memberName(backupRead(file.fd, nameLength, offset + 46)); entry.directory = entry.name.endsWith('/');
      if (seen.has(entry.name)) { throw new Error('备份ZIP成员重复'); } seen.add(entry.name);
      const mode = (u32(header, 38) >>> 16) & 0xf000;
      if (mode !== 0 && mode !== (entry.directory ? 0x4000 : 0x8000)) { throw new Error('备份ZIP包含链接或特殊文件'); }
      let compressed = u32(header, 20); entry.size = u32(header, 24); entry.offset = u32(header, 42); entry.crc = u32(header, 16);
      const extra = backupRead(file.fd, extraLength, offset + 46 + nameLength);
      let cursor = 0, found64 = false;
      while (cursor + 4 <= extra.byteLength) {
        const tag = u16(extra, cursor), size = u16(extra, cursor + 2); cursor += 4;
        if (cursor + size > extra.byteLength) { throw new Error('ZIP扩展信息被截断'); }
        if (tag === 1) {
          if (found64) { throw new Error('ZIP64扩展重复'); } found64 = true;
          let field = cursor;
          if (entry.size === 4294967295) { if (field + 8 > cursor + size) { throw new Error('ZIP64长度缺失'); } entry.size = u64(extra, field); field += 8; }
          if (compressed === 4294967295) { if (field + 8 > cursor + size) { throw new Error('ZIP64长度缺失'); } compressed = u64(extra, field); field += 8; }
          if (entry.offset === 4294967295) { if (field + 8 > cursor + size) { throw new Error('ZIP64偏移缺失'); } entry.offset = u64(extra, field); }
        }
        cursor += size;
      }
      if (cursor !== extra.byteLength || entry.size !== compressed || (entry.directory && entry.size !== 0)) { throw new Error('备份ZIP成员长度不一致'); }
      if ((entry.name === 'manifest.json' && entry.size > 8 * 1024 * 1024) || (entry.name === 'files.index.jsonl' && entry.size > 256 * 1024 * 1024)) { throw new Error('备份元数据超过上限'); }
      total += entry.size;
      if (total > BACKUP_TOTAL_LIMIT || entry.offset + 30 > centralStart) { throw new Error('备份ZIP内容超过上限'); }
      const local = backupRead(file.fd, 30, entry.offset);
      const localNameSize = u16(local, 26), localExtraSize = u16(local, 28);
      entry.dataOffset = entry.offset + 30 + localNameSize + localExtraSize;
      if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== u16(header, 8) || u16(local, 8) !== 0 || u32(local, 14) !== entry.crc ||
        localNameSize !== nameLength || entry.dataOffset + entry.size > centralStart || memberName(backupRead(file.fd, localNameSize, entry.offset + 30)) !== entry.name) { throw new Error('备份ZIP本地头与目录不一致'); }
      const localSize = u32(local, 22), localCompressed = u32(local, 18);
      if ((localSize !== entry.size && localSize !== 4294967295) || (localCompressed !== entry.size && localCompressed !== 4294967295)) { throw new Error('备份ZIP本地长度不一致'); }
      entries.push(entry); offset = endOffset;
    }
    if (offset !== centralStart + centralSize || !seen.has('manifest.json') || !seen.has('files.index.jsonl')) { throw new Error('备份ZIP目录不完整'); }
    const sorted = entries.slice().sort((left: BackupZipEntry, right: BackupZipEntry) => left.offset - right.offset);
    let previous = 0;
    for (const entry of sorted) {
      if (entry.offset < previous) { throw new Error('备份ZIP成员内容重叠'); }
      previous = entry.dataOffset + entry.size;
    }
    return entries;
  } finally { fileIo.closeSync(file); }
}
export async function backupZipExtract(path: string, root: string, entries: BackupZipEntry[], current: () => boolean,
  progress: (bytes: number) => void): Promise<Map<string, string>> {
  const input = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
  const hashes = new Map<string, string>();
  try {
    for (const entry of entries) {
      backupCheck(current);
      const parts = entry.name.replace(/\/$/, '').split('/'); let parent = root;
      for (let index = 0; index < parts.length - (entry.directory ? 0 : 1); index++) { parent += '/' + parts[index]; backupMkdir(parent); }
      if (entry.directory) { continue; }
      const target = root + '/' + entry.name;
      if (fileIo.accessSync(target)) { throw new Error('备份解包目标重复'); }
      const output = fileIo.openSync(target, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW);
      const digest = cryptoFramework.createMd('SHA256');
      try {
        let remaining = entry.size, position = entry.dataOffset;
        while (remaining > 0) {
          backupCheck(current);
          const buffer = backupRead(input.fd, Math.min(BACKUP_CHUNK, remaining), position);
          backupWrite(output.fd, buffer); await digest.update({ data: new Uint8Array(buffer) });
          remaining -= buffer.byteLength; position += buffer.byteLength; progress(buffer.byteLength);
          await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
        }
        fileIo.fsyncSync(output.fd);
        hashes.set(entry.name, backupHex((await digest.digest()).data));
      } finally { fileIo.closeSync(output); }
    }
    return hashes;
  } finally { fileIo.closeSync(input); }
}
