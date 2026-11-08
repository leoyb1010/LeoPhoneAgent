import { router } from '@kit.ArkUI';
import { Sym } from './Symbols';
import { ActionButton, IconButton } from './Controls';
import { Tokens } from './Tokens';

/** 老代码里的图标名 → 系统符号名。 */
function symbolFor(icon: string): string {
  const map: Record<string, string> = {
    'add': 'plus',
    'search': 'magnifyingglass',
    'back': 'chevron_left',
    'up': 'chevron_up',
    'right': 'chevron_right',
    'close': 'xmark',
    'camera': 'camera',
    'voice': 'mic',
    'sound': 'speaker_wave_2',
    'clock': 'clock',
    'phone': 'phone',
    'pad': 'display',
    'laptop': 'computer',
    'web': 'globe_badge_message',
    'edit': 'square_and_pencil',
    'text': 'doc_text',
    'restore': 'arrow_counterclockwise',
    'albums': 'photo',
    'ok': 'checkmark',
    'share': 'dot_radiowaves_left_and_right',
    'scan': 'puzzle',
    'email': 'text_bubble_left_2',
    'copy': 'doc_filled_on_doc',
    'pause': 'pause'
  };
  const hit = map[icon];
  return hit !== undefined ? hit : icon;
}

/**
 * 列表行前面的图标块:有图标时是实心圆角方块 + 白色符号(和设置页一样);
 * 只有字(服务商缩写)时是浅色底 + 彩色字。
 */
@Component
export struct IconCircle {
  @StorageProp('themeTick') tick: number = 0;
  @Prop box: number = Tokens.iconCircle;
  @Prop glyph: number = Tokens.iconGlyph;
  @Prop color: string = Tokens.accent;
  @Prop mark: string = '';
  @Prop icon: string = '';
  @Prop pinned: boolean = false;

  build() {
    Stack() {
      if (this.icon.length > 0) {
        Sym({ name: symbolFor(this.icon), dim: this.glyph, color: '#FFFFFF' })
      } else {
        Text(this.mark)
          .fontSize(this.glyph - 2)
          .fontColor('#FFFFFF')
          .fontWeight(FontWeight.Bold)
      }
    }
    .width(this.box)
    .height(this.box)
    .backgroundColor(this.color)
    .borderRadius(this.box >= 40 ? this.box / 2 : 8)
  }
}

@Component
export struct StatusPill {
  @StorageProp('themeTick') tick: number = 0;
  @Prop label: string = '';
  @Prop dot: string = Tokens.online;

  build() {
    Row() {
      Column()
        .width(7)
        .height(7)
        .borderRadius(3.5)
        .backgroundColor(this.dot)
      Text(this.label)
        .fontSize(Tokens.pill)
        .fontColor(Tokens.muted)
        .fontWeight(FontWeight.Medium)
        .margin({ left: 6 })
    }
    .padding({ left: 12, right: 12, top: 7, bottom: 7 })
    .backgroundColor(Tokens.surface)
    .borderRadius(50)
  }
}

@Component
export struct SettingsRow {
  @StorageProp('themeTick') tick: number = 0;
  /** 系统符号名(见 Symbols.ets)。 */
  @Prop icon: string = 'ellipsis_circle';
  @Prop mark: string = '';
  @Prop color: string = Tokens.accent;
  @Prop title: string = '';
  @Prop subtitle: string = '';
  /** 不是第一行:上面画一条缩进的细线(和 iOS 设置一样)。 */
  @Prop divider: boolean = false;
  onOpen: () => void = () => {
  };

  build() {
    Column() {
      if (this.divider) {
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .margin({ left: 58 })
      }
      Button({ type: ButtonType.Normal }) {
        Row() {
        Stack() {
          if (this.mark) {
            Text(this.mark).fontSize(13).fontWeight(FontWeight.Medium).fontColor('#FFFFFF')
          } else {
            Sym({ name: this.icon, dim: Tokens.settingsGlyph, color: '#FFFFFF' })
          }
        }
        .width(Tokens.settingsIcon)
        .height(Tokens.settingsIcon)
        .backgroundColor(this.color)
        .borderRadius(8)
        Column() {
          Text(this.title)
            .fontSize(Tokens.rowTitle)
            .fontColor(Tokens.text)
          if (this.subtitle.length > 0) {
            Text(this.subtitle)
              .fontSize(12.5)
              .fontColor(Tokens.secondary)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .margin({ top: 2 })
          }
        }
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 14 })
        .layoutWeight(1)
        Sym({ name: 'chevron_right', dim: 13, color: Tokens.muted })
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .constraintSize({ minHeight: 52 })
      }
      .width('100%')
      .padding(0)
      .borderRadius(0)
      .backgroundColor('#00000000')
      .stateEffect(true)
      .accessibilityText(this.title)
      .accessibilityDescription(this.subtitle)
      .onClick(() => { this.onOpen(); })
    }
    .width('100%')
  }
}

/** 二级页面的顶栏:左边返回、中间标题、右边可选一个文字按钮(和 iOS / 安卓的导航栏一样)。 */
@Component
export struct NavBar {
  @StorageProp('themeTick') tick: number = 0;
  @Prop title: string = '';
  @Prop action: string = '';
  onBack: () => void = () => { router.back(); };
  onAction: () => void = () => {
  };

  build() {
    Stack() {
      Text(this.title)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .padding({ left: 72, right: 72 })
      Row() {
        IconButton({ icon: 'chevron_left', label: '返回', onTap: () => { this.onBack(); } })
        Blank()
        if (this.action.length > 0) {
          ActionButton({ label: this.action, variant: 'quiet', fullWidth: false,
            onTap: () => { this.onAction(); } })
        }
      }
      .width('100%')
    }
    .width('100%')
    .height(56)
    .padding({ left: 6, right: 8 })
  }
}
