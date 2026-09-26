import { ChatItem, durationText, toolLabel } from '../local/AgentText';
import { MarkdownText } from '../theme/Markdown';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

/** 工具 → 图标。 */
export function toolSym(name: string): string {
  if (name === 'web_search') {
    return 'magnifyingglass';
  }
  if (name === 'web_fetch' || name === 'open_url' || name === 'open_app_link' || name === 'browser_use') {
    return 'link';
  }
  if (name === 'file_read' || name === 'file_list') {
    return name === 'file_list' ? 'folder' : 'doc_text';
  }
  if (name === 'file_write' || name === 'file_edit') {
    return 'square_and_pencil';
  }
  if (name === 'read_image') {
    return 'photo';
  }
  if (name === 'memory_write' || name === 'memory_get') {
    return 'book';
  }
  if (name === 'mcp_tools' || name === 'mcp_call') {
    return 'puzzle';
  }
  if (name === 'weather') {
    return 'cloud_sun_fill';
  }
  if (name === 'location') {
    return 'location_north_up_right_fill';
  }
  if (name === 'set_alarm') {
    return 'alarm';
  }
  if (name === 'set_reminder') {
    return 'calendar_badge_clock';
  }
  if (name === 'notify') {
    return 'bell';
  }
  if (name === 'flashlight') {
    return 'flashlight_on_fill';
  }
  if (name === 'dial' || name === 'device_info') {
    return 'phone';
  }
  if (name === 'clipboard_write') {
    return 'doc_filled_on_doc';
  }
  return 'wand_and_stars';
}

function statusColor(status: string): string {
  if (status === 'ok') {
    return Tokens.online;
  }
  if (status === 'fail') {
    return Tokens.danger;
  }
  if (status === 'lost') {
    return Tokens.warn;
  }
  return Tokens.secondary;
}

/** 一轮回答上面的「✦ LeoPhoneAgent」。 */
@Component
export struct AssistantHead {
  @Prop name: string = 'LeoPhoneAgent';

  build() {
    Row() {
      Sym({ name: 'wand_and_stars_fill', dim: 16, color: Tokens.sparkleA })
      Text(this.name)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .margin({ left: 6 })
    }
    .margin({ bottom: 6 })
  }
}

/** 你说的话:右边灰色气泡,带图和附件。 */
@Component
export struct UserBubble {
  @Prop text: string = '';
  @Prop imagePath: string = '';
  @Prop files: string[] = [];

  build() {
    Column() {
      if (this.imagePath.length > 0) {
        Image(this.imagePath)
          .width(120)
          .height(120)
          .objectFit(ImageFit.Cover)
          .borderRadius(12)
          .margin({ bottom: 6 })
      }
      ForEach(this.files, (name: string) => {
        Row() {
          Sym({ name: 'paperclip', dim: 13, color: Tokens.secondary })
          Text(name)
            .fontSize(13)
            .fontColor(Tokens.secondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 4 })
        }
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .backgroundColor(Tokens.surface)
        .borderRadius(10)
        .margin({ bottom: 6 })
      }, (name: string) => name)
      if (this.text.length > 0) {
        Text(this.text)
          .fontSize(16.5)
          .lineHeight(24)
          .fontColor(Tokens.userText)
          .copyOption(CopyOptions.LocalDevice)
          .padding({ left: 14, right: 14, top: 9, bottom: 9 })
          .backgroundColor(Tokens.userBubble)
          .borderRadius(Tokens.bubbleRadius)
      }
    }
    .alignItems(HorizontalAlign.End)
    .constraintSize({ maxWidth: Tokens.bubbleMax })
  }
}

/** 一次工具调用:胶囊里是图标、做的事、用时;在跑时转圈,点开看结果。 */
@Component
export struct ToolCapsule {
  @Prop item: ChatItem = new ChatItem();
  @State open: boolean = false;

  build() {
    Column() {
      Row() {
        Sym({
          name: toolSym(this.item.name),
          dim: 14,
          color: this.item.status === 'running' ? Tokens.accent : statusColor(this.item.status)
        })
        Text(toolLabel(this.item.name, this.item.title))
          .fontSize(13.5)
          .fontColor(Tokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .constraintSize({ maxWidth: 260 })
          .margin({ left: 8, right: 10 })
        if (this.item.status === 'running') {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(Tokens.secondary)
        } else if (this.item.status === 'lost') {
          Text('没跑完')
            .fontSize(12)
            .fontColor(Tokens.warn)
        } else if (this.item.seconds >= 0) {
          Text(durationText(this.item.seconds))
            .fontSize(12)
            .fontFamily('monospace')
            .fontColor(Tokens.muted)
        }
      }
      .height(Tokens.capsule)
      .padding({ left: 12, right: 12 })
      .backgroundColor(Tokens.toolCapsule)
      .border({ width: Tokens.hairline, color: Tokens.separator })
      .borderRadius(Tokens.capsule / 2)
      .constraintSize({ maxWidth: 420 })
      .onClick(() => {
        if (this.item.text.length > 0) {
          this.open = !this.open;
        }
      })
      if (this.open && this.item.text.length > 0) {
        Text(this.item.text.length > 1200 ? `${this.item.text.substring(0, 1200)}…` : this.item.text)
          .fontSize(12.5)
          .lineHeight(18)
          .fontFamily('monospace')
          .fontColor(Tokens.secondary)
          .copyOption(CopyOptions.LocalDevice)
          .padding(10)
          .backgroundColor(Tokens.surface)
          .borderRadius(10)
          .margin({ top: 6 })
          .constraintSize({ maxWidth: '100%' })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 3, bottom: 3 })
  }
}

/** 说完的一轮里的工具折成一条「已工作 N 步 · 用时」,点开展开(iOS 同样)。 */
@Component
export struct WorkedRow {
  @Prop item: ChatItem = new ChatItem();
  onToggle: () => void = () => {
  };

  build() {
    Row() {
      Sym({
        name: this.item.status === 'fail' ? 'exclamationmark_triangle' : 'list_bullet',
        dim: 14,
        color: this.item.status === 'fail' ? Tokens.warn : Tokens.secondary
      })
      Text(`已工作 ${this.item.count} 步${this.item.seconds >= 0 ? ` · ${durationText(this.item.seconds)}` : ''}`)
        .fontSize(13.5)
        .fontColor(Tokens.secondary)
        .margin({ left: 8 })
      Sym({ name: this.item.open ? 'chevron_up' : 'chevron_down', dim: 12, color: Tokens.muted })
        .margin({ left: 6 })
    }
    .height(Tokens.capsule - 4)
    .padding({ left: 12, right: 12 })
    .backgroundColor(Tokens.toolCapsule)
    .borderRadius((Tokens.capsule - 4) / 2)
    .margin({ top: 3, bottom: 3 })
    .onClick(() => {
      this.onToggle();
    })
  }
}

/** 系统提示:短的在两条细线中间,长的(斜杠命令的输出)放在灰卡片里。 */
@Component
export struct NoticeRow {
  @Prop text: string = '';

  build() {
    if (this.text.length > 36 || this.text.indexOf('\n') >= 0) {
      Text(this.text)
        .fontSize(13)
        .lineHeight(19)
        .fontColor(Tokens.secondary)
        .copyOption(CopyOptions.LocalDevice)
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .backgroundColor(Tokens.surface)
        .borderRadius(12)
        .width('100%')
        .margin({ top: 4, bottom: 4 })
    } else {
      Row() {
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .layoutWeight(1)
        Text(this.text)
          .fontSize(12)
          .fontColor(Tokens.muted)
          .margin({ left: 10, right: 10 })
          .maxLines(2)
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .layoutWeight(1)
      }
      .width('100%')
      .margin({ top: 8, bottom: 8 })
    }
  }
}

/** 出错:红底一条,右边是「继续」或「重试」。 */
@Component
export struct ErrorRow {
  @Prop text: string = '';
  @Prop action: string = '';
  onAction: () => void = () => {
  };

  build() {
    Row() {
      Sym({ name: 'exclamationmark_triangle', dim: 15, color: Tokens.danger })
      Text(this.text)
        .fontSize(13)
        .lineHeight(18)
        .fontColor(Tokens.danger)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .copyOption(CopyOptions.LocalDevice)
        .layoutWeight(1)
        .margin({ left: 8, right: 8 })
      if (this.action.length > 0) {
        Text(this.action)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.action === '继续' ? '#FFFFFF' : Tokens.text)
          .padding({ left: 12, right: 12, top: 6, bottom: 6 })
          .backgroundColor(this.action === '继续' ? Tokens.warn : Tokens.card)
          .borderRadius(14)
          .onClick(() => {
            this.onAction();
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: 12, right: 10, top: 10, bottom: 10 })
    .backgroundColor(Tokens.errorTint)
    .borderRadius(12)
    .margin({ top: 6, bottom: 6 })
  }
}

/** 压缩摘要:「已压缩前面 N 条消息」,点开看摘要。 */
@Component
export struct SummaryRow {
  @Prop item: ChatItem = new ChatItem();
  @State open: boolean = false;

  build() {
    Column() {
      Row() {
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .layoutWeight(1)
        Row() {
          Sym({ name: 'rectangle_stack', dim: 12, color: Tokens.muted })
          Text(`已压缩前面 ${this.item.count} 条消息`)
            .fontSize(12)
            .fontColor(Tokens.muted)
            .margin({ left: 4 })
          Sym({ name: this.open ? 'chevron_up' : 'chevron_down', dim: 10, color: Tokens.muted })
            .margin({ left: 4 })
        }
        .margin({ left: 10, right: 10 })
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .layoutWeight(1)
      }
      .width('100%')
      .onClick(() => {
        this.open = !this.open;
      })
      if (this.open) {
        Column() {
          MarkdownText({ text: this.item.text, color: Tokens.secondary, textSize: 14 })
        }
        .padding(12)
        .backgroundColor(Tokens.surface)
        .borderRadius(12)
        .margin({ top: 8 })
      }
    }
    .width('100%')
    .margin({ top: 10, bottom: 10 })
  }
}

/** 在等模型:「LeoPhoneAgent 正在思考」。 */
@Component
export struct TypingRow {
  build() {
    Row() {
      LoadingProgress()
        .width(16)
        .height(16)
        .color(Tokens.muted)
      Text('LeoPhoneAgent 正在思考')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .margin({ left: 8 })
    }
    .margin({ top: 6, bottom: 6 })
  }
}

/** 说完的回答下面:复制、朗读,最新一条还能重新生成。 */
@Component
export struct ReplyActions {
  @Prop regenerate: boolean = false;
  @State copied: boolean = false;
  onCopy: () => void = () => {
  };
  onSpeak: () => void = () => {
  };
  onRegenerate: () => void = () => {
  };

  build() {
    Row() {
      this.action(this.copied ? 'checkmark' : 'doc_filled_on_doc', () => {
        this.onCopy();
        this.copied = true;
        setTimeout(() => {
          this.copied = false;
        }, 1500);
      })
      this.action('speaker_wave_2', () => {
        this.onSpeak();
      })
      if (this.regenerate) {
        this.action('arrow_clockwise', () => {
          this.onRegenerate();
        })
      }
    }
    .margin({ top: 2, bottom: 4 })
  }

  @Builder
  action(name: string, tap: () => void) {
    Row() {
      Sym({ name: name, dim: 16, color: name === 'checkmark' ? Tokens.online : Tokens.muted })
    }
    .width(32)
    .height(32)
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      tap();
    })
  }
}
