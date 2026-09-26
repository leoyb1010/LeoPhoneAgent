/**
 * 系统符号图标(HarmonyOS Symbol,和 iOS 的 SF Symbols 一类)。$r 只认写死的名字,所以这里一个个列出来。
 */
@Component
export struct Sym {
  @Prop name: string = 'ellipsis_circle';
  @Prop dim: number = 20;
  @Prop color: string = '#000000';

  build() {
    SymbolGlyph(this.res())
      .fontSize(this.dim)
      .fontColor([this.color])
  }

  private res(): Resource {
    if (this.name === 'paperclip') {
      return $r('sys.symbol.paperclip');
    }
    if (this.name === 'plus') {
      return $r('sys.symbol.plus');
    }
    if (this.name === 'arrow_up') {
      return $r('sys.symbol.arrow_up');
    }
    if (this.name === 'arrow_down') {
      return $r('sys.symbol.arrow_down');
    }
    if (this.name === 'stop_circle_fill') {
      return $r('sys.symbol.stop_circle_fill');
    }
    if (this.name === 'square_fill') {
      return $r('sys.symbol.square_fill');
    }
    if (this.name === 'gearshape') {
      return $r('sys.symbol.gearshape');
    }
    if (this.name === 'magnifyingglass') {
      return $r('sys.symbol.magnifyingglass');
    }
    if (this.name === 'computer') {
      return $r('sys.symbol.computer');
    }
    if (this.name === 'ellipsis_circle') {
      return $r('sys.symbol.ellipsis_circle');
    }
    if (this.name === 'checkmark') {
      return $r('sys.symbol.checkmark');
    }
    if (this.name === 'xmark') {
      return $r('sys.symbol.xmark');
    }
    if (this.name === 'xmark_circle_fill') {
      return $r('sys.symbol.xmark_circle_fill');
    }
    if (this.name === 'checkmark_circle_fill') {
      return $r('sys.symbol.checkmark_circle_fill');
    }
    if (this.name === 'exclamationmark_triangle') {
      return $r('sys.symbol.exclamationmark_triangle');
    }
    if (this.name === 'doc') {
      return $r('sys.symbol.doc');
    }
    if (this.name === 'doc_text') {
      return $r('sys.symbol.doc_text');
    }
    if (this.name === 'doc_plaintext') {
      return $r('sys.symbol.doc_plaintext');
    }
    if (this.name === 'doc_filled_on_doc') {
      return $r('sys.symbol.doc_filled_on_doc');
    }
    if (this.name === 'photo') {
      return $r('sys.symbol.ohos_photo');
    }
    if (this.name === 'camera') {
      return $r('sys.symbol.camera');
    }
    if (this.name === 'mic') {
      return $r('sys.symbol.mic');
    }
    if (this.name === 'mic_fill') {
      return $r('sys.symbol.mic_fill');
    }
    if (this.name === 'speaker_wave_2') {
      return $r('sys.symbol.speaker_wave_2');
    }
    if (this.name === 'arrow_clockwise') {
      return $r('sys.symbol.arrow_clockwise');
    }
    if (this.name === 'arrow_counterclockwise') {
      return $r('sys.symbol.arrow_counterclockwise');
    }
    if (this.name === 'chevron_down') {
      return $r('sys.symbol.chevron_down');
    }
    if (this.name === 'chevron_up') {
      return $r('sys.symbol.chevron_up');
    }
    if (this.name === 'chevron_right') {
      return $r('sys.symbol.chevron_right');
    }
    if (this.name === 'chevron_left') {
      return $r('sys.symbol.chevron_left');
    }
    if (this.name === 'hand') {
      return $r('sys.symbol.hand');
    }
    if (this.name === 'bolt_fill') {
      return $r('sys.symbol.bolt_fill');
    }
    if (this.name === 'clock') {
      return $r('sys.symbol.clock');
    }
    if (this.name === 'pin_fill') {
      return $r('sys.symbol.pin_fill');
    }
    if (this.name === 'trash') {
      return $r('sys.symbol.trash');
    }
    if (this.name === 'lightbulb') {
      return $r('sys.symbol.lightbulb');
    }
    if (this.name === 'folder') {
      return $r('sys.symbol.folder');
    }
    if (this.name === 'square_and_pencil') {
      return $r('sys.symbol.square_and_pencil');
    }
    if (this.name === 'list_bullet') {
      return $r('sys.symbol.list_bullet');
    }
    if (this.name === 'bell') {
      return $r('sys.symbol.bell');
    }
    if (this.name === 'calendar_badge_clock') {
      return $r('sys.symbol.calendar_badge_clock');
    }
    if (this.name === 'alarm') {
      return $r('sys.symbol.alarm');
    }
    if (this.name === 'flashlight_on_fill') {
      return $r('sys.symbol.flashlight_on_fill');
    }
    if (this.name === 'link') {
      return $r('sys.symbol.link');
    }
    if (this.name === 'phone') {
      return $r('sys.symbol.phone');
    }
    if (this.name === 'location_north_up_right_fill') {
      return $r('sys.symbol.location_north_up_right_fill');
    }
    if (this.name === 'cloud_sun_fill') {
      return $r('sys.symbol.cloud_sun_fill');
    }
    if (this.name === 'puzzle') {
      return $r('sys.symbol.puzzle');
    }
    if (this.name === 'wand_and_stars') {
      return $r('sys.symbol.wand_and_stars');
    }
    if (this.name === 'wand_and_stars_fill') {
      return $r('sys.symbol.wand_and_stars_fill');
    }
    if (this.name === 'book') {
      return $r('sys.symbol.book');
    }
    if (this.name === 'display') {
      return $r('sys.symbol.display');
    }
    if (this.name === 'keyboard') {
      return $r('sys.symbol.keyboard');
    }
    if (this.name === 'quote') {
      return $r('sys.symbol.quote');
    }
    if (this.name === 'memory_module') {
      return $r('sys.symbol.memory_module');
    }
    if (this.name === 'globe_badge_message') {
      return $r('sys.symbol.globe_badge_message');
    }
    if (this.name === 'person') {
      return $r('sys.symbol.person');
    }
    if (this.name === 'text_bubble_left_2') {
      return $r('sys.symbol.text_bubble_left_2');
    }
    if (this.name === 'waveform_bubble') {
      return $r('sys.symbol.waveform_bubble');
    }
    if (this.name === 'square_grid_2x2') {
      return $r('sys.symbol.square_grid_2x2');
    }
    if (this.name === 'timer') {
      return $r('sys.symbol.timer');
    }
    if (this.name === 'dot_radiowaves_left_and_right') {
      return $r('sys.symbol.dot_radiowaves_left_and_right');
    }
    if (this.name === 'externaldrive') {
      return $r('sys.symbol.externaldrive');
    }
    if (this.name === 'house') {
      return $r('sys.symbol.house');
    }
    if (this.name === 'rectangle_stack') {
      return $r('sys.symbol.rectangle_stack');
    }
    if (this.name === 'square_and_arrow_down') {
      return $r('sys.symbol.square_and_arrow_down');
    }
    if (this.name === 'arrow_down_to_line') {
      return $r('sys.symbol.arrow_down_to_line');
    }
    if (this.name === 'ellipsis_message') {
      return $r('sys.symbol.ellipsis_message');
    }
    if (this.name === 'bookshelf') {
      return $r('sys.symbol.bookshelf');
    }
    if (this.name === 'calendar') {
      return $r('sys.symbol.calendar');
    }
    if (this.name === 'wifi') {
      return $r('sys.symbol.wifi');
    }
    if (this.name === 'hand_point_up_tap') {
      return $r('sys.symbol.hand_point_up_tap');
    }
    if (this.name === 'pause') {
      return $r('sys.symbol.pause');
    }
    return $r('sys.symbol.ellipsis_circle');
  }
}
