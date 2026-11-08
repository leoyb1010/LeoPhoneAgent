import { common } from '@kit.AbilityKit';
import { zlib } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { backupRead, backupWrite, backupMkdir, backupRemove, backupFsyncDir, BACKUP_CHUNK } from '../backup/BackupFiles';

const MAX_ARCHIVE: number = 256 * 1024 * 1024;
const MAX_ENTRY: number = 64 * 1024 * 1024;
const MAX_EXPANDED: number = 128 * 1024 * 1024;
class SkillZipEntry {
  name: string = ''; directory: boolean = false; flags: number = 0; method: number = 0;
  crc: number = 0; compressed: number = 0; size: number = 0; offset: number = 0; dataOffset: number = 0; end: number = 0;
}
export class InstalledSkillBundle { directory: string = ''; archive: string = ''; }
function valid(condition: boolean): void { if (!condition) throw new Error('技能ZIP格式、路径或大小无效'); }
function u16(buffer: ArrayBuffer, offset: number): number { return new DataView(buffer).getUint16(offset, true); }
function u32(buffer: ArrayBuffer, offset: number): number { return new DataView(buffer).getUint32(offset, true); }
function read(fd: number, size: number, offset: number): ArrayBuffer {
  valid(Number.isSafeInteger(size) && size >= 0 && size <= MAX_ENTRY);
  const result = new Uint8Array(size);
  for (let done = 0; done < size; done += BACKUP_CHUNK) result.set(new Uint8Array(backupRead(fd, Math.min(BACKUP_CHUNK, size - done), offset + done)), done);
  return result.buffer;
}
function name(buffer: ArrayBuffer): string { return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(buffer)); }
function extras(buffer: ArrayBuffer): void {
  let cursor = 0;
  while (cursor + 4 <= buffer.byteLength) { const kind = u16(buffer, cursor); const length = u16(buffer, cursor + 2); cursor += 4; valid(kind !== 1 && cursor + length <= buffer.byteLength); cursor += length; }
  valid(cursor === buffer.byteLength);
}

/** The iOS SafeSkillArchive ZIP32 contract. Validate every header before staging an immutable tree. */
export class SkillBundle {
  static safePath(path: string): boolean {
    return !!path && path.length <= 1024 && !/[\\:\u0000-\u001f\u007f]/.test(path) &&
      path.split('/').length <= 32 && path.split('/').every((part: string) => !!part && part !== '.' && part !== '..');
  }
  static safeDirectory(directory: string): boolean { return /^bundle-[a-f0-9-]{36}$/i.test(directory); }

  private static directory(fd: number): SkillZipEntry[] {
    const size = fileIo.statSync(fd).size; valid(size >= 22 && size <= MAX_ARCHIVE);
    const tailStart = Math.max(0, size - 65557); const tail = backupRead(fd, size - tailStart, tailStart); let end = -1;
    for (let at = tail.byteLength - 22; at >= 0; at--) if (u32(tail, at) === 0x06054b50 && at + 22 + u16(tail, at + 20) === tail.byteLength) { end = at; break; }
    valid(end >= 0); const count = u16(tail, end + 10); const centralStart = u32(tail, end + 16); const centralSize = u32(tail, end + 12);
    valid(u16(tail, end + 4) === 0 && u16(tail, end + 6) === 0 && u16(tail, end + 8) === count && count > 0 && count <= 4096 && centralStart + centralSize === tailStart + end);
    const entries: SkillZipEntry[] = []; const names: Set<string> = new Set(); const files: Set<string> = new Set(); let cursor = centralStart; let expanded = 0;
    for (let i = 0; i < count; i++) {
      valid(cursor + 46 <= centralStart + centralSize); const header = backupRead(fd, 46, cursor); valid(u32(header, 0) === 0x02014b50);
      const entry = new SkillZipEntry(); entry.flags = u16(header, 8); entry.method = u16(header, 10); entry.crc = u32(header, 16);
      entry.compressed = u32(header, 20); entry.size = u32(header, 24); entry.offset = u32(header, 42);
      const nameSize = u16(header, 28); const extraSize = u16(header, 30); const commentSize = u16(header, 32);
      valid(nameSize > 0 && nameSize <= 1024 && cursor + 46 + nameSize + extraSize + commentSize <= centralStart + centralSize);
      valid((entry.flags & ~0x080e) === 0 && (entry.method === 0 || entry.method === 8) && (entry.method === 8 || (entry.flags & 6) === 0));
      valid(u16(header, 34) === 0 && entry.compressed !== 0xffffffff && entry.offset !== 0xffffffff && entry.size <= MAX_ENTRY && expanded + entry.size <= MAX_EXPANDED);
      valid(entry.size <= 1024 * 1024 || entry.size / Math.max(1, entry.compressed) <= 1000);
      const nameBytes = backupRead(fd, nameSize, cursor + 46); entry.name = name(nameBytes); entry.directory = entry.name.endsWith('/');
      const path = entry.directory ? entry.name.substring(0, entry.name.length - 1) : entry.name; valid(SkillBundle.safePath(path));
      const canonical = path.normalize('NFC').toLowerCase(); valid(!names.has(canonical)); names.add(canonical); if (!entry.directory) files.add(canonical);
      const mode = (u32(header, 38) >>> 16) & 0xf000; valid(mode === 0 || mode === (entry.directory ? 0x4000 : 0x8000));
      extras(backupRead(fd, extraSize, cursor + 46 + nameSize)); cursor += 46 + nameSize + extraSize + commentSize; expanded += entry.size;
      valid(entry.offset + 30 <= centralStart); const local = backupRead(fd, 30, entry.offset);
      valid(u32(local, 0) === 0x04034b50 && u16(local, 6) === entry.flags && u16(local, 8) === entry.method && u16(local, 26) === nameSize);
      entry.dataOffset = entry.offset + 30 + nameSize + u16(local, 28); valid(entry.dataOffset <= centralStart && entry.dataOffset + entry.compressed <= centralStart);
      valid(name(backupRead(fd, nameSize, entry.offset + 30)) === entry.name); extras(backupRead(fd, u16(local, 28), entry.offset + 30 + nameSize));
      if (!(entry.flags & 8)) valid(u32(local, 14) === entry.crc && u32(local, 18) === entry.compressed && u32(local, 22) === entry.size);
      entry.end = entry.dataOffset + entry.compressed;
      if (entry.flags & 8) {
        valid(entry.end + 12 <= centralStart); const signature = backupRead(fd, 4, entry.end); if (u32(signature, 0) === 0x08074b50) entry.end += 4;
        valid(entry.end + 12 <= centralStart); const descriptor = backupRead(fd, 12, entry.end);
        valid(u32(descriptor, 0) === entry.crc && u32(descriptor, 4) === entry.compressed && u32(descriptor, 8) === entry.size); entry.end += 12;
      }
      entries.push(entry);
    }
    valid(cursor === centralStart + centralSize);
    const ordered = entries.slice().sort((a: SkillZipEntry, b: SkillZipEntry) => a.offset - b.offset); let previousEnd = 0;
    for (const entry of ordered) { valid(entry.offset >= previousEnd); previousEnd = entry.end; }
    for (const path of names) { const parts = path.split('/'); while (parts.length > 1) { parts.pop(); valid(!files.has(parts.join('/'))); } }
    return entries;
  }

  private static async inflate(bytes: ArrayBuffer, expected: number): Promise<ArrayBuffer> {
    const zip = zlib.createZipSync(); const output = new ArrayBuffer(expected + 1);
    const stream: zlib.ZStream = { nextIn: bytes, availableIn: bytes.byteLength, nextOut: output, availableOut: expected + 1 };
    valid(await zip.inflateInit2(stream, -15) === zlib.ReturnStatus.OK);
    try {
      const status = await zip.inflate(stream, zlib.CompressFlushMode.FINISH);
      valid(status === zlib.ReturnStatus.STREAM_END && stream.totalIn === bytes.byteLength && stream.availableIn === 0 && stream.totalOut === expected && stream.availableOut === 1);
      return (stream.nextOut ?? output).slice(0, expected);
    } finally { await zip.inflateEnd(stream); }
  }

  static async install(context: common.Context, archive: string, body: string): Promise<InstalledSkillBundle> {
    const stat = fileIo.lstatSync(archive); valid(stat.isFile() && !stat.isSymbolicLink());
    const input = fileIo.openSync(archive, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW); let stage = '';
    try {
      const entries = SkillBundle.directory(input.fd); const root = context.filesDir + '/skill-bundles'; backupMkdir(root);
      const result = new InstalledSkillBundle(); result.directory = 'bundle-' + util.generateRandomUUID(false); result.archive = 'bundle.zip';
      stage = root + '/.' + result.directory + '.tmp'; backupMkdir(stage); backupMkdir(stage + '/tree');
      const checksum = zlib.createChecksumSync();
      for (const entry of entries) {
        const bytes = read(input.fd, entry.compressed, entry.dataOffset);
        const decoded = entry.method === 8 ? await SkillBundle.inflate(bytes, entry.size) : bytes;
        valid(decoded.byteLength === entry.size && (!entry.directory || !decoded.byteLength)); valid((await checksum.crc32(0, decoded)) >>> 0 === entry.crc);
        const components = entry.name.split('/').filter((part: string) => !!part); let directory = stage + '/tree';
        for (let i = 0; i < components.length - (entry.directory ? 0 : 1); i++) { directory += '/' + components[i]; backupMkdir(directory); }
        if (!entry.directory) SkillBundle.write(directory + '/' + components[components.length - 1], decoded);
      }
      const content = new util.TextEncoder().encodeInto(body); const bodyBuffer = new ArrayBuffer(content.byteLength);
      new Uint8Array(bodyBuffer).set(content); SkillBundle.write(stage + '/tree/SKILL.md', bodyBuffer);
      const archiveFile = fileIo.openSync(stage + '/bundle.zip', fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.NOFOLLOW);
      try {
        const size = fileIo.statSync(input.fd).size;
        for (let offset = 0; offset < size; offset += BACKUP_CHUNK) backupWrite(archiveFile.fd, backupRead(input.fd, Math.min(BACKUP_CHUNK, size - offset), offset));
        fileIo.fsyncSync(archiveFile.fd);
      } finally { fileIo.closeSync(archiveFile); }
      backupFsyncDir(stage + '/tree'); backupFsyncDir(stage); fileIo.renameSync(stage, root + '/' + result.directory); stage = ''; backupFsyncDir(root); return result;
    } finally { fileIo.closeSync(input); if (stage) backupRemove(stage); }
  }
  private static write(path: string, data: ArrayBuffer): void {
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    try { backupWrite(file.fd, data); fileIo.fsyncSync(file.fd); } finally { fileIo.closeSync(file); }
  }
  static archive(context: common.Context, directory: string): string {
    if (!SkillBundle.safeDirectory(directory)) return '';
    let path = context.filesDir;
    for (const part of ['skill-bundles', directory]) { path += '/' + part; const stat = fileIo.lstatSync(path); valid(stat.isDirectory() && !stat.isSymbolicLink()); }
    path += '/bundle.zip'; const stat = fileIo.lstatSync(path); valid(stat.isFile() && !stat.isSymbolicLink()); return path;
  }
  static resource(context: common.Context, directory: string, relative: string): string {
    if (!SkillBundle.safeDirectory(directory) || !SkillBundle.safePath(relative)) return '';
    let path = context.filesDir;
    const components = ['skill-bundles', directory, 'tree'].concat(relative.split('/'));
    for (let i = 0; i < components.length; i++) {
      path += '/' + components[i]; if (!fileIo.accessSync(path)) return '';
      const stat = fileIo.lstatSync(path); if (stat.isSymbolicLink() || (i < components.length - 1 ? !stat.isDirectory() : !stat.isFile())) return '';
    }
    return path;
  }
}
