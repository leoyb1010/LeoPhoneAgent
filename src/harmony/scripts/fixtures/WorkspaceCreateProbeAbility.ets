import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { backupCopy } from '../backup/BackupFiles';
import * as nativeLinux from 'libleolinux.so';

class WorkspaceCreateReport {
  success: boolean = false;
  linuxBootRequired: boolean = false;
  existingResult: number = -999;
  existingPreserved: boolean = false;
  newFdReadWrite: boolean = false;
  newMode: number = 0;
  procEntrySymlink: boolean = false;
  procResult: number = -999;
  procTargetPreserved: boolean = false;
  finalSlots: number = -1;
  finalTasks: number = -1;
  error: string = '';
}
export default class WorkspaceCreateProbeAbility extends UIAbility {
  onCreate(_want: Want): void {
    this.probe().catch((error: Error) => { AppStorage.setOrCreate('workspaceCreateProbeStatus', error.message); });
  }
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/WorkspaceCreateProbePage'); }
  private async probe(): Promise<void> {
    const report = new WorkspaceCreateReport();
    const root = this.context.cacheDir + '/workspace-create-' + util.generateRandomUUID(false);
    let made = false;
    let parent: fileIo.File | null = null;
    let existing: fileIo.File | null = null;
    let proc: fileIo.File | null = null;
    let created: number = -1;
    try {
      const before = nativeLinux.scopeCounts();
      if (before.slots !== 0 || before.tasks !== 0) { throw new Error('该微探针要求未运行Linux任务'); }
      fileIo.mkdirSync(root); made = true;
      parent = fileIo.openSync(root, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      existing = fileIo.openSync(root + '/existing.txt', fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      fileIo.writeSync(existing.fd, 'OWN_EXISTING_CONTENT'); fileIo.fsyncSync(existing.fd);
      const original = (await backupCopy(root + '/existing.txt', '', () => true)).sha256;
      report.existingResult = nativeLinux.createWorkspaceFile(parent.fd, 'existing.txt');
      report.existingPreserved = report.existingResult === -17 && (await backupCopy(root + '/existing.txt', '', () => true)).sha256 === original;
      created = nativeLinux.createWorkspaceFile(parent.fd, 'new.txt');
      if (created < 0) { throw new Error('新建raw fd失败 ' + created); }
      const payload = new util.TextEncoder().encodeInto('OWN_NATIVE_RAW_FD');
      const count = fileIo.writeSync(created, payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
      fileIo.fsyncSync(created); fileIo.lseek(created, 0, fileIo.WhenceType.SEEK_SET);
      const bytes = new ArrayBuffer(payload.byteLength);
      report.newFdReadWrite = count === payload.byteLength && fileIo.readSync(created, bytes) === bytes.byteLength &&
        util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(bytes)) === 'OWN_NATIVE_RAW_FD';
      report.newMode = fileIo.statSync(created).mode & 511;
      fileIo.closeSync(created); created = -1;
      proc = fileIo.openSync('/proc/self/fd', fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      const leaf = String(existing.fd);
      report.procEntrySymlink = fileIo.lstatSync('/proc/self/fd/' + leaf).isSymbolicLink();
      report.procResult = nativeLinux.createWorkspaceFile(proc.fd, leaf);
      report.procTargetPreserved = report.procResult < 0 && (await backupCopy(root + '/existing.txt', '', () => true)).sha256 === original;
      const after = nativeLinux.scopeCounts(); report.finalSlots = after.slots; report.finalTasks = after.tasks;
      report.success = report.existingPreserved && report.newFdReadWrite && report.newMode === 384 &&
        report.procEntrySymlink && report.procTargetPreserved && after.slots === 0 && after.tasks === 0;
    } catch (error) { report.error = (error as Error).message; }
    finally {
      if (created >= 0) { fileIo.closeSync(created); }
      if (proc) { fileIo.closeSync(proc); }
      if (existing) { fileIo.closeSync(existing); }
      if (parent) { fileIo.closeSync(parent); }
      const output = fileIo.openSync(this.context.cacheDir + '/workspace-create-native.json', fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      try { fileIo.writeSync(output.fd, JSON.stringify(report)); fileIo.fsyncSync(output.fd); } finally { fileIo.closeSync(output); }
      if (made) { fileIo.rmdirSync(root); }
      AppStorage.setOrCreate('workspaceCreateProbeStatus', JSON.stringify(report));
      console.info('LEOBOT_WORKSPACE_CREATE_PROBE ' + JSON.stringify(report));
    }
  }
}
