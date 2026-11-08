import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { router } from '@kit.ArkUI';
import { inputMethod } from '@kit.ImeKit';
import { webview } from '@kit.ArkWeb';
import { Attachments } from '../chat/Attachments';
import { WorkspaceFile, WorkspaceStore } from '../store/WorkspaceStore';
import { NavBar } from '../theme/Widgets';
import { ActionButton, IconButton } from '../theme/Controls';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct WorkspacePage {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('keyboardVisible') keyboardVisible: boolean = false;
  @State directory: string = '';
  @State showFolder: boolean = false;
  @State folderName: string = '';
  @State rows: WorkspaceFile[] = [];
  @State query: string = '';
  @State selected: string = '';
  @State preview: string = '';
  @State truncated: boolean = false;
  @State previewError: string = '';
  @State message: string = '';
  @State error: string = '';
  @State busy: string = '';
  @State wide: boolean = false;
  @State html: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private alive: boolean = false;

  aboutToAppear(): void { this.alive = true; this.refresh(); }
  aboutToDisappear(): void { this.alive = false; }
  onBackPress(): boolean {
    if (this.keyboardVisible) { inputMethod.getController().hideSoftKeyboard().catch(() => {}); return true; }
    if (this.showFolder) { this.showFolder = false; return true; }
    if (!this.wide && this.selected) { this.selected = ''; return true; }
    if (this.directory) { this.navigate(this.directory.split('/').slice(0, -1).join('/')); return true; }
    return false;
  }
  private refresh(): void {
    try {
      this.rows = WorkspaceStore.list(getContext(this), this.directory).sort((a: WorkspaceFile, b: WorkspaceFile) => Number(b.directory) - Number(a.directory) || b.modified - a.modified || a.name.localeCompare(b.name));
      this.error = '';
    } catch (error) { this.error = `${error}`; }
  }
  private matches(): WorkspaceFile[] {
    const query = this.query.trim().toLocaleLowerCase();
    return this.rows.filter((row: WorkspaceFile) => row.name.toLocaleLowerCase().indexOf(query) >= 0);
  }
  private fileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  private open(row: WorkspaceFile): void {
    if (row.directory) { this.navigate(row.path); return; }
    this.selected = row.path; this.html = false; this.preview = ''; this.previewError = ''; this.message = '';
    try {
      const result = WorkspaceStore.preview(getContext(this), row.path);
      this.preview = result.text; this.truncated = result.truncated;
    } catch (error) { this.previewError = `${error}`; }
  }
  private async importFiles(): Promise<void> {
    if (this.busy) return;
    this.busy = 'import'; this.error = ''; this.message = '';
    try {
      const result = await Attachments.pickFiles(getContext(this) as common.UIAbilityContext, this.directory);
      if (!this.alive) return;
      this.refresh();
      if (result.names.length || result.skipped) this.message = `已导入 ${result.names.length} 个文件` + (result.skipped ? `，${result.skipped} 个文件超过 20 MB` : '');
    } catch (error) { if (this.alive) this.error = `${error}`; }
    finally { this.busy = ''; }
  }
  private async exportFile(): Promise<void> {
    if (this.busy || !this.selected) return;
    const name = this.selected;
    this.busy = 'export'; this.error = ''; this.message = '';
    try {
      const options = new picker.DocumentSaveOptions(); options.newFileNames = [name.substring(name.lastIndexOf('/') + 1)];
      const uris = await new picker.DocumentViewPicker(getContext(this) as common.UIAbilityContext).save(options);
      if (!this.alive || !uris.length) return;
      await WorkspaceStore.exportTo(getContext(this), name, uris[0]);
      if (this.alive) this.message = '文件已导出';
    } catch (error) { if (this.alive) this.error = `${error}`; }
    finally { this.busy = ''; }
  }
  private navigate(directory: string): void {
    this.directory = directory; this.query = ''; this.selected = ''; this.html = false;
    this.preview = ''; this.previewError = ''; this.message = ''; this.refresh();
  }
  private createFolder(): void {
    if (!this.showFolder || !this.folderName.trim()) return;
    try {
      const name = this.folderName.trim();
      if (/[\\/]/.test(name)) throw new Error('请输入一个文件夹名称');
      WorkspaceStore.createDirectory(getContext(this), (this.directory ? this.directory + '/' : '') + name);
      this.showFolder = false; this.folderName = ''; this.refresh();
    } catch (error) { this.error = (error as Error).message; }
  }
  private loadHTML(): void {
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'">';
    this.controller.loadData('<!doctype html><meta charset="UTF-8">' + policy + this.preview, 'text/html', 'UTF-8');
  }
  build() {
    Column() {
      NavBar({ title: '沙箱文件', onBack: () => { if (!this.onBackPress()) router.back(); } })
      Scroll() {
        Row({ space: 4 }) {
          ActionButton({ label: '工作区', variant: 'quiet', fullWidth: false, onTap: () => this.navigate('') })
          ForEach(this.directory ? this.directory.split('/') : [], (part: string, index: number) => {
            Sym({ name: 'chevron_right', dim: 11, color: Tokens.muted })
            ActionButton({ label: part, variant: 'quiet', fullWidth: false,
              onTap: () => this.navigate(this.directory.split('/').slice(0, index + 1).join('/')) })
          }, (part: string, index: number) => part + '|' + index)
        }.padding({ left: 8, right: 8 })
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%').height(52)

      if (this.error || this.message) {
        Text(this.error || this.message).fontSize(13).fontColor(this.error ? Tokens.danger : Tokens.secondary)
          .width('100%').padding({ left: 20, right: 20, bottom: 12 })
      }
      Row() {
        if (this.wide || !this.selected) { this.fileList() }
        if (this.wide) Divider().vertical(true).height('100%').color(Tokens.separator).strokeWidth(0.5)
        if (this.wide || this.selected) { this.filePreview() }
      }.width('100%').layoutWeight(1).alignItems(VerticalAlign.Top)
    }.width('100%').height('100%').backgroundColor(Tokens.bg)
      .onAreaChange((_old: Area, area: Area) => { const width = Number.parseFloat(`${area.width}`); if (width > 0) this.wide = width >= 720; })
      .bindSheet($$this.showFolder, this.folderSheet(), { height: SheetSize.FIT_CONTENT, backgroundColor: Tokens.card })
  }
  @Builder
  fileList() {
    Column({ space: 12 }) {
      Row({ space: 6 }) {
        TextInput({ placeholder: '搜索文件名', text: this.query }).onChange((value: string) => { this.query = value; })
          .height(46).fontSize(15).fontColor(Tokens.text).placeholderColor(Tokens.muted)
          .backgroundColor(Tokens.surface).borderRadius(14).layoutWeight(1).accessibilityText('搜索文件名')
        IconButton({ icon: 'arrow_counterclockwise', label: '刷新文件', isEnabled: !this.busy, onTap: () => this.refresh() })
      }.width('100%')
      Row() {
        Text(this.rows.length + ' 项').fontSize(13).fontColor(Tokens.secondary).layoutWeight(1)
        IconButton({ icon: 'folder_badge_plus', label: '新建文件夹', isEnabled: !this.busy, onTap: () => { this.error = ''; this.showFolder = true; } })
        ActionButton({ label: '导入', icon: 'plus', variant: 'quiet', fullWidth: false, busy: this.busy === 'import', isEnabled: !this.busy, onTap: () => this.importFiles() })
      }.width('100%')
      List({ space: 6 }) {
        if (!this.matches().length) {
          ListItem() {
            Column({ space: 10 }) {
              Sym({ name: 'folder', dim: 32, color: Tokens.muted })
              Text(this.query ? '没有匹配的文件' : '文件会收在这里').fontSize(17).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
              Text(this.query ? '换一个文件名试试' : '导入资料，或让 LeoBot 在对话中创建文件。').fontSize(14).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
            }.width('100%').padding({ top: 52, bottom: 32, left: 16, right: 16 })
          }
        }
        ForEach(this.matches(), (row: WorkspaceFile) => {
          ListItem() {
            Button({ type: ButtonType.Normal }) {
              Row({ space: 12 }) {
                Sym({ name: row.directory ? 'folder' : 'doc_text', dim: 22, color: this.selected === row.path ? Tokens.accent : Tokens.secondary })
                Column({ space: 5 }) {
                  Text(row.name).fontSize(15).fontWeight(FontWeight.Medium).fontColor(Tokens.text).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
                  Text(row.directory ? '文件夹' : this.fileSize(row.size)).fontSize(12).fontColor(Tokens.secondary)
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                Sym({ name: 'chevron_right', dim: 12, color: Tokens.muted })
              }.padding(14).width('100%').constraintSize({ minHeight: 68 })
            }.width('100%').padding(0).borderRadius(14).stateEffect(true)
              .backgroundColor(this.selected === row.path ? Tokens.accentSoft : Tokens.card)
              .accessibilityText(row.name + '，' + (row.directory ? '文件夹' : this.fileSize(row.size))).onClick(() => this.open(row))
          }
        }, (row: WorkspaceFile) => `${row.path}|${row.size}|${row.modified}`)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off)
    }.width(this.wide ? 320 : '100%').height('100%').padding({ left: 16, right: 16, bottom: 12 }).backgroundColor(Tokens.grouped)
  }
  @Builder
  folderSheet() {
    Column({ space: 16 }) {
      Text('新建文件夹').fontSize(21).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
      TextInput({ text: this.folderName, placeholder: '文件夹名称' }).fontColor(Tokens.text).placeholderColor(Tokens.muted)
        .height(48).backgroundColor(Tokens.surface).accessibilityText('新文件夹名称').onChange((value: string) => { this.folderName = value; })
      if (this.error) Text(this.error).fontSize(14).fontColor(Tokens.danger).width('100%')
      ActionButton({ label: '创建', isEnabled: !!this.folderName.trim(), onTap: () => this.createFolder() })
      ActionButton({ label: '取消', variant: 'quiet', onTap: () => { this.showFolder = false; } })
    }.width('100%').padding(24)
  }
  @Builder
  filePreview() {
    Column({ space: 12 }) {
      if (this.selected) {
        Row({ space: 8 }) {
          Text(this.selected).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          ActionButton({ label: '导出', icon: 'square_and_arrow_down', variant: 'secondary', fullWidth: false, busy: this.busy === 'export', isEnabled: !this.busy, onTap: () => this.exportFile() })
        }.width('100%')
        if (/\.html?$/i.test(this.selected) && !this.previewError && !this.truncated) {
          ActionButton({ label: this.html ? '查看源码' : '预览网页', variant: 'quiet', fullWidth: false, onTap: () => { this.html = !this.html; } })
        }
        if (this.previewError) {
          Text(this.previewError).fontSize(14).fontColor(Tokens.secondary).width('100%').padding({ top: 20 })
        } else if (this.html) {
          Web({ src: '', controller: this.controller, incognitoMode: true }).javaScriptAccess(true).fileAccess(false).blockNetwork(true)
            .domStorageAccess(false).multiWindowAccess(false).onPermissionRequest((event) => event?.request.deny()).onOverrideUrlLoading(() => true).onControllerAttached(() => this.loadHTML()).width('100%').layoutWeight(1)
        } else {
          if (this.truncated) Text('预览前 128 KB，导出可查看完整文件').fontSize(12).fontColor(Tokens.secondary).width('100%')
          Scroll() {
            Text(this.preview || '文件内容为空').fontSize(14).lineHeight(23).fontColor(this.preview ? Tokens.text : Tokens.muted)
              .fontFamily('monospace').copyOption(CopyOptions.LocalDevice).width('100%').padding({ bottom: 32 })
          }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
        }
      } else {
        Blank()
        Sym({ name: 'doc_text', dim: 36, color: Tokens.muted })
        Text('选择文件预览').fontSize(21).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
        Text('工作区中的资料与生成结果都保存在本机。').fontSize(14).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
        Blank()
      }
    }.layoutWeight(1).height('100%').padding(24).constraintSize({ maxWidth: Tokens.readable })
  }
}
