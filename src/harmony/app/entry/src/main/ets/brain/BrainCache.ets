import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { BrainAPI } from './BrainAPI';

class CacheFile {
  path: string = '';
  size: number = 0;
  modified: number = 0;
}
/** Disposable app-private cache, names bind both connection generation and stable media ID. */
export class BrainCache {
  private static roots: Set<string> = new Set();
  static async image(context: common.Context, id: string, preview: boolean): Promise<ArrayBuffer> {
    BrainAPI.requireUnlocked();
    const generation = BrainAPI.generation();
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: new util.TextEncoder().encodeInto(generation + '|' + id + '|' + preview) });
    let key = '';
    for (const byte of (await digest.digest()).data) key += byte.toString(16).padStart(2, '0');
    BrainAPI.requireUnlocked();
    const root = context.cacheDir + '/brain-images';
    BrainCache.roots.add(root);
    if (!fileIo.accessSync(root)) fileIo.mkdirSync(root);
    const path = root + '/' + key;
    if (fileIo.accessSync(path)) {
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      try {
        const size = fileIo.statSync(file.fd).size;
        if (size > 0 && size <= 64 * 1024 * 1024) {
          const buffer = new ArrayBuffer(size);
          if (fileIo.readSync(file.fd, buffer) === size && BrainAPI.active(generation)) { BrainAPI.requireUnlocked(); return buffer; }
        }
      } finally { fileIo.closeSync(file); }
    }
    const bytes = await BrainAPI.bytes('/media/' + encodeURIComponent(id) + (preview ? '/preview' : '/thumbnail'));
    BrainAPI.requireUnlocked();
    if (!BrainAPI.active(generation)) throw new Error('资料库连接已改变');
    const temporary = path + '.' + util.generateRandomUUID(false) + '.tmp';
    try {
      const file = fileIo.openSync(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
      try { if (fileIo.writeSync(file.fd, bytes) !== bytes.byteLength) throw new Error('缓存写入不完整'); }
      finally { fileIo.closeSync(file); }
      fileIo.renameSync(temporary, path);
      BrainCache.prune(root);
    } catch (_error) {
      // Cache failures must not hide a successfully fetched, authorized image.
      try { if (fileIo.accessSync(temporary)) fileIo.unlinkSync(temporary); } catch (_cleanup) { }
    }
    return bytes;
  }
  private static prune(root: string): void {
    const files: CacheFile[] = [];
    let total = 0;
    for (const name of fileIo.listFileSync(root)) {
      const stat = fileIo.statSync(root + '/' + name);
      if (!stat.isFile()) continue;
      const entry = new CacheFile(); entry.path = root + '/' + name; entry.size = stat.size; entry.modified = stat.mtime;
      files.push(entry); total += entry.size;
    }
    if (total <= 400 * 1024 * 1024) return;
    files.sort((a: CacheFile, b: CacheFile) => a.modified - b.modified);
    for (const entry of files) {
      if (total <= 300 * 1024 * 1024) break;
      fileIo.unlinkSync(entry.path); total -= entry.size;
    }
  }
  static clear(): void {
    for (const root of BrainCache.roots) {
      try { for (const name of fileIo.listFileSync(root)) fileIo.unlinkSync(root + '/' + name); } catch (_error) { }
    }
  }
}
