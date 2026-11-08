import { AppNavigation } from '../navigation/AppNavigation';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import { BackupStore } from '../backup/BackupStore';
import { BackupPackage, BackupPackagePreview, BackupProgress } from '../backup/BackupPackage';
import { backupRemove } from '../backup/BackupFiles';
import { ActionButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct BackupPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State busy: boolean = false;
  @State operation: string = '';
  @State message: string = '';
  @State progress: string = '';
  @State count: number = 0;
  @State hasSelection: boolean = false;
  private legacy: string = '';
  private preview: BackupPackagePreview | null = null;
  private generation: number = 0;
  private alive: boolean = true;

  aboutToAppear(): void { this.alive = true; }
  aboutToDisappear(): void {
    this.alive = false; this.generation++; BackupPackage.cancel();
    BackupPackage.discard(getContext(this) as common.Context, this.preview); this.preview = null;
  }
  private current(generation: number): boolean { return this.alive && this.generation === generation; }
  private update(state: BackupProgress): void {
    this.progress = state.stage + ' · ' + state.files + ' 个文件 · ' + (state.bytes / 1024 / 1024).toFixed(1) + ' MiB' + (state.percent >= 0 ? ' · ' + state.percent + '%' : '');
  }
  private cancel(): void { this.generation++; BackupPackage.cancel(); this.message = '正在取消并清理临时文件'; }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '备份与恢复' })
      Scroll() {
        Column({ space: 20 }) {
          Column({ space: 8 }) {
            Text('留存完整的本机工作').fontSize(25).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
            Text('会话、附件、工作区、录音、技能、记忆和配置按文件流式保存。标准 ZIP 内的文件以 SHA-256 寻址，相同内容只保存一份。')
              .fontSize(14).fontColor(Tokens.secondary).width('100%').lineHeight(22)
            Text('备份含私人内容。系统加密凭据独立保存，恢复到其他设备后需要重新登录。当前 .leobak 用于鸿蒙本机数据恢复。未发送草稿随本机备份保存，跨端同步处理已发送内容。')
              .fontSize(13).fontColor(Tokens.secondary).width('100%').lineHeight(20)
          }.padding(20).backgroundColor(Tokens.surface).borderRadius(20).width('100%')
          Column({ space: 12 }) {
            ActionButton({ label: '导出本机备份', icon: 'square_and_arrow_up', busy: this.busy && this.operation === 'export', isEnabled: !this.busy, fullWidth: true, onTap: () => { this.exportBackup(); } })
            ActionButton({ label: '选择备份文件', variant: 'secondary', icon: 'folder', busy: this.busy && this.operation === 'choose', isEnabled: !this.busy, fullWidth: true, onTap: () => { this.choose(); } })
            if (this.hasSelection) {
              Text(`已校验 ${this.count} 个文件。恢复覆盖备份内的同名文件，其他文件保留。旧文件先写入可恢复的磁盘快照，重新打开应用后执行恢复。`)
                .fontSize(14).fontColor(Tokens.text).width('100%').lineHeight(22)
              ActionButton({ label: '确认恢复并关闭应用', variant: 'danger', busy: this.busy && this.operation === 'restore', isEnabled: !this.busy, fullWidth: true, onTap: () => { this.restore(); } })
            }
            if (this.busy) {
              LoadingProgress().width(28).height(28).color(Tokens.accent)
              Text(this.progress || (this.operation === 'choose' ? '正在读取并校验备份' : (this.operation === 'restore' ? '正在准备恢复快照' : '正在整理备份文件'))).fontSize(13).fontColor(Tokens.secondary).width('100%').accessibilityDescription(this.busy ? '备份操作进度' : '备份操作结果')
              ActionButton({ label: '取消当前操作', variant: 'quiet', onTap: () => { this.cancel(); } })
            }
            if (this.message) { Text(this.message).fontSize(14).fontColor(Tokens.text).width('100%').lineHeight(22).accessibilityDescription(this.busy ? '备份操作进度' : '备份操作结果') }
          }.padding(20).backgroundColor(Tokens.surface).borderRadius(20).width('100%')
        }.padding(Tokens.pagePad).width('100%').constraintSize({ maxWidth: 680 })
      }.layoutWeight(1).width('100%').align(Alignment.Top).scrollBar(BarState.Auto)
    }.height('100%').width('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  private async exportBackup(): Promise<void> {
    if (this.busy) return; this.operation = 'export';
    this.busy = true; this.message = ''; const generation = ++this.generation;
    let packagePath = '';
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const archive = await BackupPackage.create(context, () => this.current(generation), (state: BackupProgress) => { if (this.current(generation)) { this.update(state); } });
      packagePath = archive.path;
      if (!this.current(generation)) { return; }
      const options = new picker.DocumentSaveOptions(); options.newFileNames = [`LeoBot-${Date.now()}.leobak`];
      const destinations = await new picker.DocumentViewPicker(context).save(options);
      if (!destinations.length || !this.current(generation)) { return; }
      const state = new BackupProgress(); state.stage = '正在写入所选文档'; state.files = archive.count;
      try {
        await BackupPackage.copyDocument(packagePath, destinations[0], true, () => this.current(generation), (bytes: number) => { state.bytes += bytes; this.update(state); });
      } catch (error) {
        try { fileIo.unlinkSync(destinations[0]); } catch (_cleanup) { this.message = '导出中断，所选文档可能保留未完成内容'; }
        throw error as Error;
      }
      this.message = `已完整导出 ${archive.count} 个文件，共 ${(archive.bytes / 1024 / 1024).toFixed(1)} MiB`;
    } catch (error) { this.message = (this.message ? this.message + '\n' : '') + `${error}`; }
    finally { if (packagePath) { backupRemove(packagePath); } this.busy = false; this.operation = ''; this.progress = ''; }
  }

  private async choose(): Promise<void> {
    if (this.busy) return; this.operation = 'choose';
    this.busy = true; this.message = ''; this.hasSelection = false; this.legacy = '';
    const context = getContext(this) as common.UIAbilityContext;
    BackupPackage.discard(context, this.preview); this.preview = null;
    const generation = ++this.generation;
    try {
      const options = new picker.DocumentSelectOptions(); options.maxSelectNumber = 1;
      const files = await new picker.DocumentViewPicker(context).select(options);
      if (!files.length || !this.current(generation)) { return; }
      const file = fileIo.openSync(files[0], fileIo.OpenMode.READ_ONLY);
      let zip = false;
      try {
        const magic = new ArrayBuffer(4);
        zip = fileIo.readSync(file.fd, magic) === 4 && new DataView(magic).getUint32(0, true) === 0x04034b50;
        if (!zip) {
          const size = fileIo.statSync(file.fd).size;
          if (size > 144 * 1024 * 1024) { throw new Error('旧版JSON备份超过大小限制'); }
          fileIo.lseek(file.fd, 0, fileIo.WhenceType.SEEK_SET);
          const buffer = new ArrayBuffer(size);
          if (fileIo.readSync(file.fd, buffer) !== size) { throw new Error('旧版备份读取不完整'); }
          this.legacy = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(buffer));
        }
      } finally { fileIo.closeSync(file); }
      if (zip) {
        const preview = await BackupPackage.preview(context, files[0], () => this.current(generation), (state: BackupProgress) => { if (this.current(generation)) { this.update(state); } });
        if (!this.current(generation)) { BackupPackage.discard(context, preview); return; }
        this.preview = preview; this.count = preview.manifest.files;
      } else {
        const archive = await BackupStore.validate(this.legacy);
        if (!this.current(generation)) { this.legacy = ''; return; }
        this.count = archive.entries.length;
      }
      this.hasSelection = true; this.message = '备份内容校验完成，请确认恢复';
    } catch (error) { this.message = `${error}`; this.legacy = ''; }
    finally { this.busy = false; this.operation = ''; this.progress = ''; }
  }

  private async restore(): Promise<void> {
    if (this.busy) return; this.operation = 'restore';
    this.busy = true; this.message = ''; const generation = ++this.generation;
    try {
      const context = getContext(this) as common.UIAbilityContext;
      if (this.preview) { await BackupPackage.prepareRestore(context, this.preview, () => this.current(generation), (state: BackupProgress) => { this.update(state); }); }
      else { await BackupStore.restore(context, this.legacy); }
      this.message = '恢复快照已准备，请重新打开 LeoBot';
      BackupPackage.discard(context, this.preview); this.preview = null; this.legacy = ''; this.hasSelection = false;
      await context.terminateSelf();
    } catch (error) { this.message = `${error}`; }
    finally { this.busy = false; this.operation = ''; this.progress = ''; }
  }
}
