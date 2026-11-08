import { curves } from '@kit.ArkUI';
import { Sym } from './Symbols';
import { Tokens } from './Tokens';
import { MotionPolicy } from './MotionPolicy';

export type ActionVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

/** Loading is supplied by the real operation. The title remains stable. */
@Component
export struct ActionButton {
  @StorageProp('themeTick') themeTick: number = 0;
  @StorageProp('motionReduced') reduced: boolean = false;
  @Prop label: string = '';
  @Prop variant: ActionVariant = 'primary';
  @Prop busy: boolean = false;
  @Prop isEnabled: boolean = true;
  @Prop fullWidth: boolean = true;
  @Prop icon: string = '';
  onTap: () => void = () => {};
  @State pressed: boolean = false;

  private fillColor(): string {
    if (this.variant === 'primary') return Tokens.accent;
    if (this.variant === 'danger') return Tokens.errorTint;
    return this.variant === 'quiet' ? '#00000000' : Tokens.surface;
  }

  private labelColor(): string {
    if (this.variant === 'primary') return Tokens.sendGlyph;
    return this.variant === 'danger' ? Tokens.danger : Tokens.text;
  }

  private touch(down: boolean): void {
    this.getUIContext().animateTo({
      duration: MotionPolicy.duration(down ? 80 : 220),
      curve: curves.springMotion(0.25, 0.86)
    }, () => { this.pressed = down && this.isEnabled && !this.busy; });
  }

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        if (this.busy && this.reduced) {
          Sym({ name: 'clock', dim: 17, color: Tokens.reactive(this.themeTick, this.labelColor()) })
        } else if (this.busy) {
          LoadingProgress().width(18).height(18).color(Tokens.reactive(this.themeTick, this.labelColor()))
        } else if (this.icon) {
          Sym({ name: this.icon, dim: 17, color: Tokens.reactive(this.themeTick, this.labelColor()) })
        }
        Text(this.label).fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor(Tokens.reactive(this.themeTick, this.labelColor())).maxLines(2).textAlign(TextAlign.Center)
      }.justifyContent(FlexAlign.Center)
    }
    .width(this.fullWidth ? '100%' : 'auto')
    .constraintSize({ minHeight: 48, minWidth: 44 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .borderRadius(14)
    .backgroundColor(Tokens.reactive(this.themeTick, this.fillColor()))
    .opacity(this.isEnabled ? 1 : 0.42)
    .scale({ x: this.pressed && this.isEnabled && !this.busy && !this.reduced ? 0.98 : 1,
      y: this.pressed && this.isEnabled && !this.busy && !this.reduced ? 0.98 : 1 })
    .enabled(this.isEnabled && !this.busy)
    .stateEffect(true)
    .accessibilityText(this.label)
    .accessibilityDescription(this.busy ? '正在处理' : '')
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) this.touch(true);
      else if (event.type === TouchType.Up || event.type === TouchType.Cancel) this.touch(false);
    })
    .onBlur(() => { this.pressed = false; })
    .onClick(() => { if (this.isEnabled && !this.busy) this.onTap(); })
  }
}

@Component
export struct IconButton {
  @StorageProp('themeTick') themeTick: number = 0;
  @StorageProp('motionReduced') reduced: boolean = false;
  @Prop icon: string = 'ellipsis_circle';
  @Prop label: string = '';
  @Prop isEnabled: boolean = true;
  @Prop selected: boolean = false;
  @Prop filled: boolean = false;
  @Prop menuItems: MenuElement[] = [];
  onTap: () => void = () => {};
  @State pressed: boolean = false;
  @State menuVisible: boolean = false;

  build() {
    Button({ type: ButtonType.Circle }) {
      Sym({ name: this.icon, dim: 20, color: Tokens.reactive(this.themeTick, this.selected ? Tokens.accent : Tokens.text) })
    }
    .width(44).height(44)
    .backgroundColor(Tokens.reactive(this.themeTick, this.selected ? Tokens.accentSoft : (this.filled ? Tokens.surface : '#00000000')))
    .opacity(this.isEnabled ? 1 : 0.4)
    .scale({ x: this.pressed && this.isEnabled && !this.reduced ? 0.93 : 1,
      y: this.pressed && this.isEnabled && !this.reduced ? 0.93 : 1 })
    .enabled(this.isEnabled).stateEffect(true)
    .accessibilityText(this.label)
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Move) return;
      this.getUIContext().animateTo({ duration: MotionPolicy.duration(120), curve: Curve.EaseOut }, () => {
        this.pressed = this.isEnabled && event.type === TouchType.Down;
      });
    })
    .onBlur(() => { this.pressed = false; })
    .onClick(() => {
      if (!this.isEnabled) return;
      if (this.menuItems.length) this.menuVisible = true;
      else this.onTap();
    })
    .bindMenu(this.menuVisible, this.menuItems, { onDisappear: () => { this.menuVisible = false; } })
  }
}

/** Rich button content still uses a native, focusable Button, never a clickable Row. */
@Component
export struct SurfaceButton {
  @StorageProp('themeTick') tick: number = 0;
  @BuilderParam content: () => void;
  build() {
    Button({ type: ButtonType.Normal }) { this.content() }
      .constraintSize({ minWidth: 44, minHeight: 44 })
      .padding(0).borderRadius(12).backgroundColor(Tokens.reactive(this.tick, Tokens.transparent)).stateEffect(true)
  }
}

@Component
export struct NavHeader {
  @StorageProp('themeTick') tick: number = 0;
  @Prop title: string = '';
  @Prop action: string = '';
  onBack: () => void = () => {};
  onAction: () => void = () => {};
  build() {
    Row({ space: 8 }) {
      IconButton({ icon: 'chevron_left', label: '返回上一页', onTap: this.onBack })
      Text(this.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.reactive(this.tick, Tokens.text))
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
      if (this.action) ActionButton({ label: this.action, variant: 'quiet', fullWidth: false, onTap: this.onAction })
    }.width('100%').constraintSize({ minHeight: 56 }).padding({ left: 6, right: 8 })
  }
}

@Component
export struct ListRow {
  @StorageProp('themeTick') tick: number = 0;
  @Prop icon: string = 'doc_text';
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop trailing: string = 'chevron_right';
  onOpen: () => void = () => {};
  @Builder
  rowButtonContent() {
      Row({ space: 14 }) {
        Sym({ name: this.icon, dim: 20, color: Tokens.reactive(this.tick, Tokens.secondary) })
        Column({ space: 3 }) {
          Text(this.title).fontSize(Tokens.rowTitle).fontColor(Tokens.reactive(this.tick, Tokens.text)).width('100%')
          if (this.subtitle) Text(this.subtitle).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).maxLines(2).width('100%')
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        if (this.trailing) Sym({ name: this.trailing, dim: 14, color: Tokens.reactive(this.tick, Tokens.muted) })
      }.width('100%').padding(14).constraintSize({ minHeight: 56 })

  }

  build() {
    SurfaceButton({ content: () => { this.rowButtonContent(); } }).width('100%').accessibilityText(this.title).accessibilityDescription(this.subtitle).onClick(this.onOpen)
  }
}

@Component
export struct FormField {
  @StorageProp('themeTick') tick: number = 0;
  @Prop label: string = '';
  @Prop value: string = '';
  @Prop placeholder: string = '';
  @Prop secret: boolean = false;
  @Prop isEnabled: boolean = true;
  onChange: (value: string) => void = () => {};
  build() {
    Column({ space: 6 }) {
      Text(this.label).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).width('100%')
      TextInput({ text: this.value, placeholder: this.placeholder })
        .type(this.secret ? InputType.Password : InputType.Normal)
        .showPasswordIcon(this.secret).enabled(this.isEnabled)
        .height(48).fontColor(Tokens.reactive(this.tick, Tokens.text)).placeholderColor(Tokens.reactive(this.tick, Tokens.muted))
        .backgroundColor(Tokens.reactive(this.tick, Tokens.input)).borderRadius(12).accessibilityText(this.label).onChange(this.onChange)
    }.width('100%')
  }
}

@Component
export struct SectionCard {
  @StorageProp('themeTick') tick: number = 0;
  @BuilderParam content: () => void;
  build() {
    Column() { this.content() }.width('100%').backgroundColor(Tokens.reactive(this.tick, Tokens.card))
      .borderRadius(Tokens.cardRadius).border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
  }
}

@Component
export struct EmptyState {
  @StorageProp('themeTick') tick: number = 0;
  @Prop icon: string = 'text_bubble_left_2';
  @Prop title: string = '';
  @Prop detail: string = '';
  @Prop action: string = '';
  onAction: () => void = () => {};
  build() {
    Column({ space: 12 }) {
      Sym({ name: this.icon, dim: 32, color: Tokens.reactive(this.tick, Tokens.muted) })
      Text(this.title).fontSize(18).fontColor(Tokens.reactive(this.tick, Tokens.text)).textAlign(TextAlign.Center)
      if (this.detail) Text(this.detail).fontSize(14).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).textAlign(TextAlign.Center)
      if (this.action) ActionButton({ label: this.action, fullWidth: false, onTap: this.onAction })
    }.width('100%').padding(24)
  }
}

/** Static placeholders: no fake progress or shimmering when reduced motion is on. */
@Component
export struct Skeleton {
  @StorageProp('themeTick') tick: number = 0;
  @Prop label: string = '正在加载';
  build() {
    Column({ space: 16 }) {
      ForEach([0, 1, 2], (row: number) => {
        Column({ space: 10 }) {
          Rect().fill(Tokens.reactive(this.tick, Tokens.surface2)).width('55%').height(16).radius(6)
          Rect().fill(Tokens.reactive(this.tick, Tokens.surface)).width('90%').height(12).radius(6)
        }.width('100%').alignItems(HorizontalAlign.Start).padding(12)
      }, (row: number) => `${row}`)
      Text(this.label).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.secondary))
    }.width('100%').padding(16).accessibilityText(this.label)
  }
}
