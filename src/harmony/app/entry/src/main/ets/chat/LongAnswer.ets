import { AppNavigation } from '../navigation/AppNavigation';
import { textPages, previewBudget } from './ChatUXPolicy';
import { MarkdownText } from '../theme/Markdown';
import { ActionButton } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Component
export struct LongAnswer {
  @StorageProp('themeTick') themeTick: number = 0;
  @Prop text: string = '';
  @Prop live: boolean = false;
  @Prop viewportHeight: number = 600;
  @State contentWidth: number = 360;
  @State expanded: boolean = false;
  private long(): boolean { return Array.from(this.text).length > previewBudget(this.contentWidth, this.viewportHeight); }
  build() {
    Column({ space: 8 }) {
      if (!this.live && this.long() && !this.expanded) {
        // Plain-text preview keeps an incomplete fenced code block from swallowing the expand action.
        Text(textPages(this.text, previewBudget(this.contentWidth, this.viewportHeight))[0] + '…')
          .fontSize(16).lineHeight(26).fontColor(Tokens.reactive(this.themeTick, Tokens.text)).width('100%')
          .maxLines(Math.floor(Math.max(240, this.viewportHeight) * 1.5 / 26))
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      } else MarkdownText({ text: this.text, selectable: false })
      if (!this.live && this.long()) {
        Row({ space: 8 }) {
          ActionButton({ label: this.expanded ? '收起长回答' : '展开全文', variant: 'quiet', fullWidth: false,
            onTap: () => { this.expanded = !this.expanded; } })
          ActionButton({ label: '阅读全文', variant: 'secondary', fullWidth: false,
            onTap: () => AppNavigation.pushUrl({ url: 'pages/LongTextPage', params: { text: this.text, title: '阅读全文' } }) })
        }.width('100%')
      }
    }.width('100%').onAreaChange((_old: Area, area: Area) => { const width = Number(area.width); if (width > 0) this.contentWidth = width; })
  }
}
