import { MediaGallery } from './MediaGallery';
import { KeyCode } from '@kit.InputKit';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';
import { IconButton, SurfaceButton } from '../theme/Controls';
import { MotionPolicy } from '../theme/MotionPolicy';

/** 原生输入区按可用高度收敛，模型与权限入口始终可达，运行时保留草稿并提供停止。 */
@Component
export struct Composer {
  @StorageProp('themeTick') themeTick: number = 0;
  @Link @Watch('draftChanged') draft: string;
  @Prop inputId: string = '';
  @Prop @Watch('focusRequested') focusRequest: number = 0;
  onFocusApplied: (ticket: number) => void = (_ticket: number) => {};
  private layoutReady: boolean = false;
  private appliedFocus: number = 0;
  @Prop placeholder: string = '给 LeoBot 交代任务';
  @Prop running: boolean = false;
  @Prop ready: boolean = true;
  @Prop compact: boolean = false;
  @Prop modelLabel: string = '';
  @Prop showApproval: boolean = true;
  @Prop fullAuto: boolean = false;
  @Prop approvalLabel: string = '';
  @Prop files: string[] = [];
  @Prop imagePath: string = '';
  @Prop imagePaths: string[] = [];
  @Prop listening: boolean = false;
  @Prop returnSend: boolean = false;
  @Prop tools: boolean = true;
  @Prop showMic: boolean = true;
  @StorageProp('motionReduced') reduced: boolean = false;
  @State inputHeight: number = 48;
  @State actionBarWidth: number = 0;
  @State sendPressed: boolean = false;
  private input: TextAreaController = new TextAreaController();
  private measureTimer: number = -1;
  onSend: () => void = () => {};
  onStop: () => void = () => {};
  onPickImage: () => void = () => {};
  onPickFiles: () => void = () => {};
  onSlash: () => void = () => {};
  onMic: () => void = () => {};
  onModel: () => void = () => {};
  onApproval: () => void = () => {};
  onRemoveFile: (index: number) => void = (_index: number) => {};
  onRemoveImage: (index: number) => void = (_index: number) => {};

  aboutToDisappear(): void { if (this.measureTimer >= 0) clearTimeout(this.measureTimer); }
  draftChanged(): void { this.measure(); }
  private measure(): void {
    if (this.measureTimer >= 0) clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => {
      this.measureTimer = -1;
      const height = this.draft.length ? this.input.getTextContentRect().height + 20 : 48;
      this.inputHeight = Math.max(48, Math.min(this.compact ? 76 : 144, height));
    }, 0);
  }

  @Builder
  modelButtonContent() {
              Row({ space: 6 }) {
                Sym({ name: 'memory_module', dim: 14, color: Tokens.reactive(this.themeTick, Tokens.secondary) })
                Text(this.modelLabel).fontSize(13).fontWeight(FontWeight.Medium).fontColor(Tokens.reactive(this.themeTick, Tokens.text))
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                Sym({ name: 'chevron_down', dim: 10, color: Tokens.reactive(this.themeTick, Tokens.muted) })
              }.padding({ left: 10, right: 10 })

  }

  @Builder
  approvalButtonContent() {
              Row({ space: 5 }) {
                Sym({ name: this.fullAuto ? 'bolt_fill' : 'hand', dim: 13, color: Tokens.reactive(this.themeTick, this.fullAuto ? Tokens.warn : Tokens.secondary) })
                Text(this.approvalLabel || (this.fullAuto ? '全自动' : '逐项确认')).fontSize(13).fontColor(Tokens.reactive(this.themeTick, this.fullAuto ? Tokens.warn : Tokens.secondary))
              }.padding({ left: 10, right: 10 })

  }

  @Builder
  sendButtonContent() {
          if (this.running) {
            Column().width(12).height(12).borderRadius(3).backgroundColor(Tokens.reactive(this.themeTick, Tokens.sendGlyph))
          } else Sym({ name: 'arrow_up', dim: 20, color: Tokens.reactive(this.themeTick, Tokens.sendGlyph) })

  }

  @Builder
  removeButtonContent() {
      Stack({ alignContent: Alignment.TopEnd }) {
        Stack() { Sym({ name: 'xmark', dim: 10, color: Tokens.reactive(this.themeTick, Tokens.onMedia) }) }
          .width(20).height(20).backgroundColor(Tokens.reactive(this.themeTick, Tokens.mediaScrim)).borderRadius(10)
      }.width(36).height(36)

  }

  build() {
    Column() {
      if (!this.compactActions() && (this.modelLabel.length > 0 || this.showApproval)) {
        Row({ space: 4 }) {
          if (this.modelLabel.length > 0) {
            SurfaceButton({ content: () => { this.modelButtonContent(); } }).layoutWeight(1).height(44).backgroundColor(Tokens.reactive(this.themeTick, Tokens.transparent)).borderRadius(12)
            .accessibilityText('选择模型，当前 ' + this.modelLabel).onClick(() => this.onModel())
          }
          if (this.showApproval) {
            SurfaceButton({ content: () => { this.approvalButtonContent(); } }).height(44).backgroundColor(Tokens.reactive(this.themeTick, this.fullAuto ? Tokens.warnTint : Tokens.transparent)).borderRadius(12)
            .accessibilityText('工具权限，' + (this.approvalLabel || (this.fullAuto ? '全自动' : '逐项确认'))).onClick(() => this.onApproval())
          }
        }.width('100%').padding({ left: 4, right: 4, top: 2 })
      }
      if (this.photos().length > 0 || this.files.length > 0) {
        Scroll() {
          Row({ space: 8 }) {
            ForEach(this.photos(), (path: string, index: number) => {
              Stack({ alignContent: Alignment.TopEnd }) {
                MediaGallery({ paths: [path], thumbnailSize: this.compact ? 48 : 64 }).width(this.compact ? 48 : 64)
                this.removeDot('移除图片 ' + (index + 1), () => this.onRemoveImage(index))
              }.width(this.compact ? 48 : 64).height(this.compact ? 48 : 64)
            }, (path: string) => path)
            ForEach(this.files, (name: string, index: number) => {
              Row({ space: 6 }) {
                Sym({ name: 'doc', dim: 18, color: Tokens.reactive(this.themeTick, Tokens.accent) })
                Text(name).fontSize(13).fontColor(Tokens.reactive(this.themeTick, Tokens.text)).maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: 116 })
                this.removeDot('移除附件 ' + name, () => this.onRemoveFile(index))
              }.height(this.compact ? 48 : 64).padding({ left: 12 }).backgroundColor(Tokens.reactive(this.themeTick, Tokens.surface)).borderRadius(12)
            }, (name: string, index: number) => `${index}:${name}`)
          }.padding({ left: 10, right: 10 })
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start)
          .height(this.compact ? 52 : 68).width('100%').margin({ top: 4 })
      }
      TextArea({ text: this.draft, placeholder: this.placeholder, controller: this.input }).id(this.inputId)
        .fontSize(16).fontColor(Tokens.reactive(this.themeTick, Tokens.text)).placeholderColor(Tokens.reactive(this.themeTick, Tokens.muted)).placeholderFont({ size: 16 })
        .backgroundColor(Tokens.reactive(this.themeTick, Tokens.transparent)).height(Math.min(this.inputHeight, this.compact ? 76 : 144))
        .constraintSize({ minHeight: 48 }).padding({ left: 14, right: 14, top: 12, bottom: 8 })
        .enterKeyType(this.returnSend && !this.running ? EnterKeyType.Send : EnterKeyType.NEW_LINE)
        .accessibilityText('任务输入框')
        .onSubmit(() => { if (this.returnSend && this.canSend()) this.onSend(); })
        .onChange((value: string) => { this.draft = value; this.measure(); })
        .onAreaChange((_previous: Area, area: Area) => {
          const width = Number.parseFloat(`${area.width}`);
          if (Number.isFinite(width) && width > 0) this.actionBarWidth = width;
          this.measure(); this.layoutReady = Number.parseFloat(`${area.width}`) > 0 && Number.parseFloat(`${area.height}`) > 0; this.applyFocus();
        })
        .onVisibleAreaChange([0, 1], (visible: boolean, ratio: number) => { if (visible && ratio > 0) this.applyFocus(); })
        .onKeyPreIme((event: KeyEvent): boolean => {
          const shortcut = event.keyCode === KeyCode.KEYCODE_ENTER && (event.metaKey === 1 || event.getModifierKeyState?.(['Ctrl']) === true);
          if (!shortcut) return false;
          if (event.type === KeyType.Down && this.canSend()) this.onSend();
          // Consume before the IME inserts its default newline after admission clears the draft.
          return true;
        })
      Row({ space: 4 }) {
        if (this.tools) {
          IconButton({ icon: 'plus', label: '添加照片或文件', filled: true, isEnabled: this.ready,
            menuItems: [{ value: '选择照片', action: () => this.onPickImage() }, { value: '添加文件', action: () => this.onPickFiles() }] })
          IconButton({ icon: 'keyboard', label: '快捷命令', onTap: () => this.onSlash(), isEnabled: this.ready })
        }
        if (this.compactActions() && this.modelLabel) IconButton({ icon: 'memory_module', label: '选择模型，当前 ' + this.modelLabel, onTap: () => this.onModel() })
        if (this.compactActions() && this.showApproval) IconButton({ icon: this.fullAuto ? 'bolt_fill' : 'hand', label: (this.approvalLabel || (this.fullAuto ? '全自动' : '逐项确认')) + '权限', selected: this.fullAuto, onTap: () => this.onApproval() })
        Blank()
        if (this.showMic && (!this.compactActions() || !this.canSend() || this.running)) IconButton({ icon: this.listening ? 'mic_fill' : 'mic', label: this.listening ? '结束语音输入' : '开始语音输入', selected: this.listening, isEnabled: this.ready, onTap: () => this.onMic() })
        if (!this.compactActions() || this.canSend() || this.running) SurfaceButton({ content: () => { this.sendButtonContent(); } }).width(44).height(44).flexShrink(0)
        .backgroundColor(Tokens.reactive(this.themeTick, this.running ? Tokens.danger : (this.canSend() ? Tokens.send : Tokens.sendOff))).borderRadius(22)
        .scale({ x: this.sendPressed && !this.reduced ? 0.94 : 1, y: this.sendPressed && !this.reduced ? 0.94 : 1 })
        .enabled(this.running || this.canSend()).accessibilityText(this.running ? '停止任务，保留草稿' : '发送消息')
        .onTouch((event: TouchEvent) => this.getUIContext().animateTo({ duration: MotionPolicy.duration(100) }, () => this.sendPressed = event.type === TouchType.Down))
        .onBlur(() => this.sendPressed = false)
        .onClick(() => { if (this.running) this.onStop(); else if (this.canSend()) this.onSend(); })
      }.width('100%').height(52).padding({ left: 8, right: 8, bottom: 4 }).flexShrink(0)
    }.width('100%').flexShrink(0).backgroundColor(Tokens.reactive(this.themeTick, Tokens.composer)).borderRadius(Tokens.composerRadius)
      .border({ width: Tokens.hairline, color: Tokens.reactive(this.themeTick, Tokens.separator) })
      .shadow({ radius: 14, color: Tokens.reactive(this.themeTick, Tokens.composerShadow), offsetY: 3 })
  }

  @Builder
  removeDot(label: string, tap: () => void) {
    SurfaceButton({ content: () => { this.removeButtonContent(); } }).width(44).height(44).backgroundColor(Tokens.reactive(this.themeTick, Tokens.transparent)).accessibilityText(label).onClick(tap)
  }
  private compactActions(): boolean { return this.compact && this.actionBarWidth >= 320; }
  private photos(): string[] { return this.imagePaths.length ? this.imagePaths : (this.imagePath ? [this.imagePath] : []); }
  focusRequested(): void { this.applyFocus(); }
  private applyFocus(): void {
    if (!this.layoutReady || !this.ready || !this.inputId || this.focusRequest <= this.appliedFocus) return;
    const ticket = this.focusRequest;
    try {
      this.getUIContext().getFocusController().requestFocus(this.inputId);
      this.appliedFocus = ticket; this.onFocusApplied(ticket);
    } catch (_error) { /* Keep the ticket until the input becomes visible in its current native window. */ }
  }
  private canSend(): boolean { return this.ready && !this.running && (this.draft.trim().length > 0 || this.files.length > 0 || this.photos().length > 0); }
}
