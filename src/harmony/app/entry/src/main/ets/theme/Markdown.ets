import { MdBlock, MdTableRow, parseTableRows, splitMarkdown } from '../local/LocalProtocol';
import { Tokens } from './Tokens';

@Component
export struct MarkdownText {
  @Prop @Watch('onText') text: string = '';
  @Prop color: string = Tokens.text;
  @Prop fill: boolean = true;
  @State gen: number = 0;

  onText(): void {
    this.gen += 1;
  }

  build() {
    Column() {
      ForEach(this.blocks(), (block: MdBlock, index: number) => {
        if (block.kind === 'h3') {
          this.mdLine(block.text, 16, FontWeight.Bold, { top: 6, bottom: 2 })
        } else if (block.kind === 'h2') {
          this.mdLine(block.text, 18, FontWeight.Bold, { top: 8, bottom: 2 })
        } else if (block.kind === 'h1') {
          this.mdLine(block.text, 20, FontWeight.Bold, { top: 8, bottom: 4 })
        } else if (block.kind === 'code') {
          Text(block.text)
            .fontSize(13)
            .fontFamily('monospace')
            .fontColor(this.color)
            .padding(8)
            .backgroundColor(Tokens.surface2)
            .borderRadius(8)
        } else if (block.kind === 'table') {
          this.tableGrid(block.text)
        } else if (block.kind === 'li') {
          this.mdLine(`• ${block.text}`, 16, FontWeight.Regular, { top: 2, bottom: 2 })
        } else {
          this.mdLine(block.text, 16, FontWeight.Regular, { top: 2, bottom: 2 })
        }
      }, (block: MdBlock, index: number) => `${this.gen}:${index}:${block.kind}:${block.text.length}`)
    }
    .alignItems(HorizontalAlign.Start)
    .constraintSize({ maxWidth: '100%' })
    .width(this.fill ? '100%' : 'auto')
  }

  @Builder
  mdLine(text: string, size: number, weight: FontWeight, pad: Padding) {
    Text(text)
      .fontSize(size)
      .fontWeight(weight)
      .fontColor(this.color)
      .padding(pad)
  }

  @Builder
  tableGrid(raw: string) {
    Column() {
      ForEach(parseTableRows(raw), (row: MdTableRow, r: number) => {
        Row() {
          ForEach(row.cells, (cell: string, c: number) => {
            Text(cell)
              .fontSize(13)
              .fontColor(this.color)
              .fontWeight(r === 0 ? FontWeight.Medium : FontWeight.Regular)
              .layoutWeight(1)
              .padding(6)
          }, (cell: string, c: number) => `${r}:${c}:${cell}`)
        }
        .width('100%')
        .backgroundColor(r === 0 ? Tokens.surface2 : Tokens.surface)
      }, (row: MdTableRow, r: number) => `r${r}:${row.cells.join('|')}`)
    }
    .width('100%')
    .borderRadius(8)
    .clip(true)
    .margin({ top: 4, bottom: 4 })
  }

  private blocks(): MdBlock[] {
    return splitMarkdown(this.text);
  }
}
