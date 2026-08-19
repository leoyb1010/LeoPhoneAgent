export class LeoRelease {
  version: string = '';
  date: string = '';
  title: string = '';
  highlights: string[] = [];
}

export class ReleaseCatalog {
  static readonly currentVersion: string = '0.1.0-alpha.1';
  static readonly currentBuild: number = 100001;

  static all(): LeoRelease[] {
    const first = new LeoRelease();
    first.version = '0.1.0-alpha.1';
    first.date = '2026-08-19';
    first.title = '鸿蒙瘦控制面';
    first.highlights = [
      '填中继钥匙后读取 /machines，不再写死三台 Mac。',
      '可对在线 Mac 或 Android 身体开新任务，断线按序号续上。',
      '审批用词与 iPhone / Android 对齐。',
      '本机 Agent 和鸿蒙当身体是后面两艘船，这版不做。'
    ];
    return [first];
  }
}
