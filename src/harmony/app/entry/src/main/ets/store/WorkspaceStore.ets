import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class WorkspaceFile {
  name: string = '';
  size: number = 0;
}

export class WorkspaceStore {
  static list(context: common.Context): WorkspaceFile[] {
    const dir = WorkspaceStore.dir(context);
    WorkspaceStore.ensureDir(dir);
    const names = fileIo.listFileSync(dir);
    const out: WorkspaceFile[] = [];
    for (let i = 0; i < names.length; i++) {
      const row = new WorkspaceFile();
      row.name = names[i];
      try {
        row.size = fileIo.statSync(`${dir}/${names[i]}`).size;
      } catch (_err) {
        row.size = 0;
      }
      out.push(row);
    }
    return out;
  }

  static read(context: common.Context, name: string): string {
    const safe = WorkspaceStore.safeName(name);
    const path = `${WorkspaceStore.dir(context)}/${safe}`;
    if (!fileIo.accessSync(path)) {
      throw new Error('沙箱里没有这个文件');
    }
    return fileIo.readTextSync(path);
  }

  static write(context: common.Context, name: string, text: string): void {
    const safe = WorkspaceStore.safeName(name);
    WorkspaceStore.ensureDir(WorkspaceStore.dir(context));
    const path = `${WorkspaceStore.dir(context)}/${safe}`;
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, text);
    } finally {
      fileIo.closeSync(file);
    }
  }

  static pathOf(context: common.Context, name: string): string {
    return `${WorkspaceStore.dir(context)}/${WorkspaceStore.safeName(name)}`;
  }

  /**
   * 附件放进沙箱:文件名里的斜杠换掉,重名就加 -2、-3。返回沙箱里的文件名(模型用它读)。
   */
  static saveUpload(context: common.Context, original: string, bytes: ArrayBuffer): string {
    WorkspaceStore.ensureDir(WorkspaceStore.dir(context));
    const clean = original.replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim() || `附件-${Date.now()}`;
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.substring(0, dot) : clean;
    const ext = dot > 0 ? clean.substring(dot) : '';
    let name = clean;
    for (let i = 2; fileIo.accessSync(`${WorkspaceStore.dir(context)}/${name}`); i++) {
      name = `${stem}-${i}${ext}`;
    }
    const file = fileIo.openSync(`${WorkspaceStore.dir(context)}/${name}`,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, bytes);
    } finally {
      fileIo.closeSync(file);
    }
    return name;
  }

  private static dir(context: common.Context): string {
    return context.filesDir + '/workspace';
  }

  private static safeName(name: string): string {
    const trimmed = name.trim().replace(/^\/+/, '');
    if (!trimmed || trimmed.indexOf('..') >= 0 || trimmed.indexOf('/') >= 0) {
      throw new Error('只允许沙箱根目录下的文件名');
    }
    return trimmed;
  }

  private static ensureDir(path: string): void {
    if (!fileIo.accessSync(path)) {
      fileIo.mkdirSync(path);
    }
  }
}
