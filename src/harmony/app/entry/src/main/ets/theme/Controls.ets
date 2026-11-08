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
          Sym({ name: 'clock', dim: 17, color: this.labelColor() })
        } else if (this.busy) {
          LoadingProgress().width(18).height(18).color(this.labelColor())
        } else if (this.icon) {
          Sym({ name: this.icon, dim: 17, color: this.labelColor() })
        }
        Text(this.label).fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor(this.labelColor()).maxLines(2).textAlign(TextAlign.Center)
      }.justifyContent(FlexAlign.Center)
    }
    .width(this.fullWidth ? '100%' : 'auto')
    .constraintSize({ minHeight: 48, minWidth: 44 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .borderRadius(14)
    .backgroundColor(this.fillColor())
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
      Sym({ name: this.icon, dim: 20, color: this.selected ? Tokens.accent : Tokens.text })
    }
    .width(44).height(44)
    .backgroundColor(this.selected ? Tokens.accentSoft : (this.filled ? Tokens.surface : '#00000000'))
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
