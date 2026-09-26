import { pasteboard } from '@kit.BasicServicesKit';
import { MdPart, MdRun, mdBlocks, mdInline, mdTableRows } from '../local/AgentText';
import { InAppBrowser } from '../local/InAppBrowser';
import { Sym } from './Symbols';
import { Tokens } from './Tokens';

/**
 * 回答里的 Markdown,画法对齐 iOS / 安卓:段落里的粗体、斜体、`代码`、链接;标题、列表、引用;
 * 代码块黑底绿字、左上角语言、右上角复制(点完变 ✓);表格带边框、太宽左右滑。文字可以长按选中复制。
 */
@Component
export struct MarkdownText {
  @Prop @Watch('onText') text: string = '';
  @Prop color: string = Tokens.text;
  @Prop fill: boolean = true;
  @Prop textSize: number = Tokens.body;
  @State parts: MdPart[] = [];

  aboutToAppear(): void {
    this.parts = mdBlocks(this.text);
  }

  onText(): void {
    this.parts = mdBlocks(this.text);
  }

  build() {
    Column() {
      ForEach(this.parts, (part: MdPart, index: number) => {
        MdPartView({ part: part, color: this.color, textSize: this.textSize, first: index === 0 })
      }, (part: MdPart, index: number) => `${index}:${part.kind}`)
    }
    .alignItems(HorizontalAlign.Start)
    .width(this.fill ? '100%' : 'auto')
  }
}

@Component
struct MdPartView {
  @Prop part: MdPart = new MdPart();
  @Prop color: string = Tokens.text;
  @Prop textSize: number = Tokens.body;
  @Prop first: boolean = false;
  @State copied: boolean = false;

  build() {
    if (this.part.kind === 'code') {
      this.codeBlock()
    } else if (this.part.kind === 'table') {
      this.table()
    } else if (this.part.kind === 'hr') {
      Divider()
        .strokeWidth(Tokens.hairline)
        .color(Tokens.separator)
        .margin({ top: 10, bottom: 10 })
    } else if (this.part.kind === 'quote') {
      Row() {
        Column()
          .width(3)
          .height('100%')
          .borderRadius(1.5)
          .backgroundColor(Tokens.separator)
        Column() {
          this.inline(this.part.text, this.textSize, FontWeight.Regular, Tokens.secondary)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 10 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
      .margin({ top: 4, bottom: 4 })
    } else if (this.part.kind === 'li' || this.part.kind === 'ol') {
      Row() {
        Text(this.part.kind === 'ol' ? `${this.part.ordinal}.` : (this.part.level > 0 ? '◦' : '•'))
          .fontSize(this.textSize)
          .fontColor(this.part.kind === 'ol' ? this.color : Tokens.secondary)
          .lineHeight(this.textSize * 1.5)
          .constraintSize({ minWidth: this.part.kind === 'ol' ? 22 : 16 })
        Column() {
          this.inline(this.part.text, this.textSize, FontWeight.Regular, this.color)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
      .padding({ left: this.part.level * 18 })
      .margin({ top: 2, bottom: 2 })
    } else if (this.part.kind === 'h1' || this.part.kind === 'h2' || this.part.kind === 'h3') {
      Column() {
        this.inline(this.part.text, this.part.kind === 'h1' ? this.textSize + 5 : (this.part.kind === 'h2' ? this.textSize + 3 : this.textSize + 1),
          FontWeight.Bold, this.color)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .margin({ top: this.first ? 0 : 12, bottom: 4 })
    } else {
      Column() {
        this.inline(this.part.text, this.textSize, FontWeight.Regular, this.color)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .margin({ top: this.first ? 0 : 6, bottom: 2 })
    }
  }

  @Builder
  inline(text: string, size: number, weight: FontWeight, color: string) {
    Text() {
      ForEach(mdInline(text), (run: MdRun, i: number) => {
        if (run.kind === 'code') {
          Span(` ${run.text} `)
            .fontFamily('monospace')
            .fontSize(size - 2)
            .fontColor(Tokens.inlineCodeText)
            .textBackgroundStyle({ color: Tokens.inlineCodeBg, radius: 5 })
        } else if (run.kind === 'bold') {
          Span(run.text)
            .fontWeight(FontWeight.Bold)
        } else if (run.kind === 'italic') {
          Span(run.text)
            .fontStyle(FontStyle.Italic)
        } else if (run.kind === 'strike') {
          Span(run.text)
            .decoration({ type: TextDecorationType.LineThrough, color: color })
        } else if (run.kind === 'link') {
          Span(run.text)
            .fontColor(Tokens.link)
            .onClick(() => {
              InAppBrowser.open(run.url);
            })
        } else {
          Span(run.text)
        }
      }, (run: MdRun, i: number) => `${i}:${run.kind}:${run.text}`)
    }
    .fontSize(size)
    .fontWeight(weight)
    .fontColor(color)
    .lineHeight(size * 1.5)
    .copyOption(CopyOptions.LocalDevice)
  }

  @Builder
  codeBlock() {
    Column() {
      Row() {
        Text(this.part.lang.length > 0 ? this.part.lang : 'text')
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor('#8E8E93')
        Blank()
        Row() {
          Sym({
            name: this.copied ? 'checkmark' : 'doc_filled_on_doc',
            dim: 14,
            color: this.copied ? Tokens.online : '#8E8E93'
          })
        }
        .padding(4)
        .onClick(() => {
          this.copyCode();
        })
      }
      .width('100%')
      .padding({ left: 12, right: 8, top: 6 })
      Scroll() {
        Text(this.part.text)
          .fontFamily('monospace')
          .fontSize(13)
          .lineHeight(19)
          .fontColor(Tokens.codeText)
          .copyOption(CopyOptions.LocalDevice)
          .padding({ left: 12, right: 12, top: 4, bottom: 12 })
      }
      .scrollable(ScrollDirection.Free)
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)
      .width('100%')
      .constraintSize({ maxHeight: 400 })
    }
    .width('100%')
    .backgroundColor(Tokens.codeBg)
    .borderRadius(8)
    .clip(true)
    .margin({ top: 8, bottom: 8 })
  }

  @Builder
  table() {
    Scroll() {
      Column() {
        ForEach(mdTableRows(this.part.text), (row: string[], r: number) => {
          Row() {
            ForEach(row, (cell: string, c: number) => {
              Text() {
                ForEach(mdInline(cell), (run: MdRun, i: number) => {
                  Span(run.text)
                    .fontWeight(run.kind === 'bold' || r === 0 ? FontWeight.Medium : FontWeight.Regular)
                    .fontColor(run.kind === 'link' ? Tokens.link : this.color)
                }, (run: MdRun, i: number) => `${i}:${run.text}`)
              }
              .fontSize(14)
              .lineHeight(20)
              .width(this.columnWidth(c))
              .padding({ left: 10, right: 10, top: 8, bottom: 8 })
              .border({ width: { right: c < row.length - 1 ? Tokens.hairline : 0 }, color: Tokens.separator })
            }, (cell: string, c: number) => `${r}:${c}`)
          }
          .backgroundColor(r === 0 ? Tokens.surface : '#00000000')
          .border({ width: { top: r > 0 ? Tokens.hairline : 0 }, color: Tokens.separator })
        }, (row: string[], r: number) => `${r}`)
      }
      .border({ width: Tokens.hairline, color: Tokens.separator, radius: 8 })
      .clip(true)
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .align(Alignment.Start)
    .width('100%')
    .margin({ top: 8, bottom: 8 })
  }

  /** 列宽按这一列最长的字估:中文一个字约 15vp,英文数字约 8vp,夹在 72–260 之间。 */
  private columnWidth(column: number): number {
    const rows = mdTableRows(this.part.text);
    let widest = 0;
    for (let r = 0; r < rows.length; r++) {
      const cell = column < rows[r].length ? rows[r][column] : '';
      let w = 0;
      for (let i = 0; i < cell.length; i++) {
        w += cell.charCodeAt(i) > 255 ? 15 : 8;
      }
      widest = Math.max(widest, w);
    }
    return Math.max(72, Math.min(260, widest + 22));
  }

  private copyCode(): void {
    try {
      pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.part.text));
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (_err) {
      // 复制不了就算了
    }
  }
}
