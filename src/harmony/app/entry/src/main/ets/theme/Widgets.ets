import { Tokens } from './Tokens';

@Component
export struct SysIcon {
  @Prop name: string = 'more';
  @Prop dim: number = 22;
  @Prop color: string = Tokens.text;

  build() {
    Image(this.res())
      .width(this.dim)
      .height(this.dim)
      .fillColor(this.color)
      .objectFit(ImageFit.Contain)
      .draggable(false)
  }

  private res(): Resource {
    if (this.name === 'add') {
      return $r('sys.media.ohos_ic_public_add');
    }
    if (this.name === 'search') {
      return $r('sys.media.ohos_ic_public_search_filled');
    }
    if (this.name === 'back') {
      return $r('sys.media.ohos_ic_public_arrow_left');
    }
    if (this.name === 'up') {
      return $r('sys.media.ohos_ic_public_arrow_up');
    }
    if (this.name === 'right') {
      return $r('sys.media.ohos_ic_public_arrow_right');
    }
    if (this.name === 'close') {
      return $r('sys.media.ohos_ic_public_close');
    }
    if (this.name === 'camera') {
      return $r('sys.media.ohos_ic_public_camera');
    }
    if (this.name === 'voice') {
      return $r('sys.media.ohos_ic_public_voice');
    }
    if (this.name === 'sound') {
      return $r('sys.media.ohos_ic_public_sound');
    }
    if (this.name === 'clock') {
      return $r('sys.media.ohos_ic_public_clock');
    }
    if (this.name === 'phone') {
      return $r('sys.media.ohos_ic_public_device_phone');
    }
    if (this.name === 'pad') {
      return $r('sys.media.ohos_ic_public_device_pad');
    }
    if (this.name === 'laptop') {
      return $r('sys.media.ohos_ic_public_device_matebook');
    }
    if (this.name === 'web') {
      return $r('sys.media.ohos_ic_public_web');
    }
    if (this.name === 'edit') {
      return $r('sys.media.ohos_ic_public_edit');
    }
    if (this.name === 'text') {
      return $r('sys.media.ohos_ic_public_text');
    }
    if (this.name === 'restore') {
      return $r('sys.media.ohos_ic_public_restore');
    }
    if (this.name === 'albums') {
      return $r('sys.media.ohos_ic_public_albums');
    }
    if (this.name === 'ok') {
      return $r('sys.media.ohos_ic_public_ok');
    }
    if (this.name === 'share') {
      return $r('sys.media.ohos_ic_public_share');
    }
    if (this.name === 'scan') {
      return $r('sys.media.ohos_ic_public_scan');
    }
    if (this.name === 'email') {
      return $r('sys.media.ohos_ic_public_email');
    }
    if (this.name === 'copy') {
      return $r('sys.media.ohos_ic_public_copy');
    }
    if (this.name === 'pause') {
      return $r('sys.media.ohos_ic_public_pause');
    }
    return $r('sys.media.ohos_ic_public_more');
  }
}

@Component
export struct IconBtn {
  @Prop name: string = 'more';
  @Prop box: number = 40;
  @Prop glyph: number = 20;
  @Prop color: string = Tokens.text;
  @Prop fill: string = Tokens.surface2;
  onTap: () => void = () => {
  };

  build() {
    Stack() {
      Column()
        .width(this.box)
        .height(this.box)
        .borderRadius(this.box / 2)
        .backgroundColor(this.fill)
      SysIcon({
        name: this.name,
        dim: this.glyph,
        color: this.color
      })
    }
    .width(this.box)
    .height(this.box)
    .onClick(() => {
      this.onTap();
    })
  }
}

@Component
export struct IconCircle {
  @Prop box: number = Tokens.iconCircle;
  @Prop glyph: number = Tokens.iconGlyph;
  @Prop color: string = Tokens.accent;
  @Prop mark: string = '';
  @Prop icon: string = '';
  @Prop pinned: boolean = false;

  build() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      Stack() {
        Column()
          .width(this.box)
          .height(this.box)
          .borderRadius(this.box / 2)
          .backgroundColor(this.color)
          .opacity(0.18)
        if (this.icon.length > 0) {
          SysIcon({
            name: this.icon,
            dim: this.glyph + 2,
            color: this.color
          })
        } else {
          Text(this.mark)
            .fontSize(this.glyph)
            .fontColor(this.color)
            .fontWeight(FontWeight.Medium)
        }
      }
      .width(this.box)
      .height(this.box)
      if (this.pinned) {
        Column()
          .width(Tokens.pinBadge)
          .height(Tokens.pinBadge)
          .borderRadius(Tokens.pinBadge / 2)
          .backgroundColor(Tokens.warn)
          .border({ width: 1.5, color: Tokens.bg })
          .margin({ right: -2, bottom: -2 })
      }
    }
    .width(this.box)
    .height(this.box)
  }
}

@Component
export struct StatusPill {
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
  @Prop icon: string = 'more';
  @Prop color: string = Tokens.accent;
  @Prop title: string = '';
  @Prop subtitle: string = '';
  onOpen: () => void = () => {
  };

  build() {
    Row() {
      IconCircle({
        box: Tokens.settingsIcon,
        glyph: Tokens.settingsGlyph,
        color: this.color,
        icon: this.icon
      })
      Column() {
        Text(this.title)
          .fontSize(Tokens.rowTitle)
          .fontColor(Tokens.text)
        if (this.subtitle.length > 0) {
          Text(this.subtitle)
            .fontSize(12)
            .fontColor(Tokens.muted)
            .margin({ top: 2 })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: Tokens.rowGap })
      .layoutWeight(1)
      SysIcon({
        name: 'right',
        dim: 16,
        color: Tokens.muted
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .onClick(() => {
      this.onOpen();
    })
  }
}
