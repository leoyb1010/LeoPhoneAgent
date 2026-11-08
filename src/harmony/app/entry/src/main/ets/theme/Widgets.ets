import { AppNavigation } from '../navigation/AppNavigation';
import { Sym } from './Symbols';
import { ActionButton, IconButton, NavHeader, ListRow } from './Controls';
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
    'scan': 'doc_text',
    'email': 'envelope',
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
  @Prop color: string = '';
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
    .backgroundColor(Tokens.reactive(this.tick, this.color || Tokens.accent))
    .borderRadius(this.box >= 40 ? this.box / 2 : 8)
  }
}

@Component
export struct StatusPill {
  @StorageProp('themeTick') tick: number = 0;
  @Prop label: string = '';
  @Prop dot: string = '';

  build() {
    Row() {
      Column()
        .width(7)
        .height(7)
        .borderRadius(3.5)
        .backgroundColor(Tokens.reactive(this.tick, this.dot || Tokens.online))
      Text(this.label)
        .fontSize(Tokens.pill)
        .fontColor(Tokens.reactive(this.tick, Tokens.muted))
        .fontWeight(FontWeight.Medium)
        .margin({ left: 6 })
    }
    .padding({ left: 12, right: 12, top: 7, bottom: 7 })
    .backgroundColor(Tokens.reactive(this.tick, Tokens.surface))
    .borderRadius(50)
  }
}

@Component
export struct SettingsRow {
  @StorageProp('themeTick') tick: number = 0;
  /** 系统符号名(见 Symbols.ets)。 */
  @Prop icon: string = 'ellipsis_circle';
  @Prop mark: string = '';
  @Prop color: string = '';
  @Prop title: string = '';
  @Prop subtitle: string = '';
  /** 不是第一行:上面画一条缩进的细线(和 iOS 设置一样)。 */
  @Prop divider: boolean = false;
  onOpen: () => void = () => {
  };

  build() {
    Column() {
      if (this.divider) Divider().strokeWidth(Tokens.hairline).color(Tokens.reactive(this.tick, Tokens.separator)).margin({ left: 48 })
      ListRow({ icon: this.icon, title: this.title, subtitle: this.subtitle, onOpen: this.onOpen })
    }.width('100%')
  }
}

/** 二级页面的顶栏:左边返回、中间标题、右边可选一个文字按钮(和 iOS / 安卓的导航栏一样)。 */
@Component
export struct NavBar {
  @StorageProp('themeTick') tick: number = 0;
  @Prop title: string = '';
  @Prop action: string = '';
  onBack: () => void = () => { AppNavigation.back(); };
  onAction: () => void = () => {
  };

  build() {
    NavHeader({ title: this.title, action: this.action, onBack: this.onBack, onAction: this.onAction })
  }
}
