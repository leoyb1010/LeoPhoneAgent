import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';

import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

class ScanPending {
  resolve: (text: string) => void = () => {};
  reject: (error: Error) => void = () => {};
  timer: number = -1;
  isCurrent: () => boolean = () => true;
}
export class DocumentScanFlow {
  private static pending: Map<string, ScanPending> = new Map();
  static async open(_context: common.UIAbilityContext, isCurrent: () => boolean = () => true): Promise<string> {
    if (!isCurrent() || AppStorage.get<boolean>('platformForeground') !== true) throw new Error('扫描任务已取消或应用不在前台');
    if (DocumentScanFlow.pending.size) throw new Error('已有扫描正在进行');
    const id = util.generateRandomUUID(false);
    return new Promise<string>((resolve, reject) => {
      const pending = new ScanPending(); pending.isCurrent = isCurrent; pending.resolve = resolve; pending.reject = reject;
      pending.timer = setTimeout(() => DocumentScanFlow.cancel(id), 5 * 60 * 1000);
      DocumentScanFlow.pending.set(id, pending);
      AppNavigation.pushUrl({ url: 'pages/DocumentScanPage', params: { 'scanId': id } }).catch((error: Error) => {
        DocumentScanFlow.cancel(id, `${error}`);
      });
    });
  }
  static active(id: string): boolean {
    const pending = DocumentScanFlow.pending.get(id);
    return pending !== undefined && pending.isCurrent();
  }
  static cancel(id: string, message: string = '文档扫描已取消'): void {
    const pending = DocumentScanFlow.pending.get(id);
    if (!pending) return;
    DocumentScanFlow.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error(message));
  }
  static async finish(context: common.Context, id: string, uris: string[], extension: string): Promise<void> {
    const pending = DocumentScanFlow.pending.get(id);
    if (!pending) return;
    const paths: string[] = [];
    const dir = context.filesDir + '/workspace';
    try {
      if (!DocumentScanFlow.active(id)) throw new Error('扫描任务已取消或已切换');
      if (!uris.length || uris.length > 12 || (extension !== '.pdf' && extension !== '.jpg')) throw new Error('扫描返回的数据无效');
      if (!fileIo.accessSync(dir)) fileIo.mkdirSync(dir);
      for (const uri of uris) {
        if (!DocumentScanFlow.active(id)) throw new Error('扫描任务已取消');
        const name = 'scan-' + util.generateRandomUUID(false) + extension;
        const source = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
        let destination: fileIo.File | undefined = undefined;
        try {
          destination = fileIo.openSync(dir + '/' + name, fileIo.OpenMode.READ_WRITE |
            fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
          paths.push(name);
          const size = fileIo.statSync(source.fd).size;
          if (!Number.isSafeInteger(size) || size <= 0) throw new Error('扫描文件为空或大小无效');
          const buffer = new ArrayBuffer(1024 * 1024);
          let copied = 0;
          while (copied < size) {
            if (!DocumentScanFlow.active(id)) throw new Error('扫描任务已取消');
            const count = await fileIo.read(source.fd, buffer, { length: Math.min(buffer.byteLength, size - copied) });
            if (!DocumentScanFlow.active(id)) throw new Error('扫描任务已取消');
            if (count <= 0 || await fileIo.write(destination.fd, buffer, { length: count }) !== count) throw new Error('扫描文件复制中断');
            copied += count;
          }
          await fileIo.fsync(destination.fd);
        } finally {
          fileIo.closeSync(source);
          if (destination) fileIo.closeSync(destination);
        }
      }
      if (!DocumentScanFlow.active(id)) throw new Error('扫描任务已取消');
      DocumentScanFlow.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(JSON.stringify({ 'paths': paths, 'status': 'scanned', 'usage': '文件已保存在本机沙箱，按需读取' }));
    } catch (error) {
      for (const name of paths) { try { fileIo.unlinkSync(dir + '/' + name); } catch (_cleanupError) { } }
      DocumentScanFlow.cancel(id, `${error}`);
    }
  }
}
