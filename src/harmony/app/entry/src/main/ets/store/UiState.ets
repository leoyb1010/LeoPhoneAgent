import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';

/**
 * App 界面进程和后台定时任务进程(ScheduleWork)之间传话用的两个小文件:
 * - ui.json:界面在不在前台、最近一次心跳。界面在前台时由它自己跑定时任务,后台进程让开,免得两边同时写档案。
 * - worker.json:后台进程最近一次写过档案的时间。界面回到前台看到它变了,就重新读档案。
 */
export class UiState {
  /** 心跳超过这么久没更新,就当界面不在了(比如在前台时被杀)。 */
  private static readonly STALE_MS: number = 2 * 60 * 1000;

  static beat(context: common.Context, foreground: boolean): void {
    UiState.write(context, 'ui.json', `{"foreground":${foreground},"at":${Date.now()}}`);
  }

  static uiBusy(context: common.Context): boolean {
    const obj = UiState.read(context, 'ui.json');
    return obj !== null && obj['foreground'] === true && Date.now() - Number(obj['at'] ?? 0) < UiState.STALE_MS;
  }

  static markWorker(context: common.Context): void {
    UiState.write(context, 'worker.json', `{"at":${Date.now()}}`);
  }

  static workerAt(context: common.Context): number {
    const obj = UiState.read(context, 'worker.json');
    return obj ? Number(obj['at'] ?? 0) : 0;
  }

  private static read(context: common.Context, name: string): Record<string, Object> | null {
    const path = `${context.filesDir}/${name}`;
    try {
      return fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, Object> : null;
    } catch (_err) {
      return null;
    }
  }

  private static write(context: common.Context, name: string, text: string): void {
    try {
      const file = fileIo.openSync(`${context.filesDir}/${name}`,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, text);
      } finally {
        fileIo.closeSync(file);
      }
    } catch (_err) {
      // 写不进去最多是两边都跑一次
    }
  }
}
