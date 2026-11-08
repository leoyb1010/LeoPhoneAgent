import { AppNavigation } from '../navigation/AppNavigation';
import { textPages } from '../chat/ChatUXPolicy';
import { ActionButton, NavHeader } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Component
export struct LongTextPage {
  @StorageProp('themeTick') tick: number = 0;
  @State title: string = '阅读全文';
  @State pages: string[] = [];
  @State page: number = 0;
  private scroller: Scroller = new Scroller();
  aboutToAppear(): void {
    const params = AppNavigation.getParams();
    this.title = typeof params.title === 'string' ? params.title as string : '阅读全文';
    this.pages = textPages(typeof params.text === 'string' ? params.text as string : '', 4000);
  }
  private move(delta: number): void { this.page += delta; this.scroller.scrollTo({ xOffset: 0, yOffset: 0 }); }
  build() {
    NavDestination() {
      Column() {
        NavHeader({ title: this.title, onBack: () => AppNavigation.back() })
        Text('长按正文选择文字；分页保留完整原文。').fontSize(13).fontColor(Tokens.secondary).padding(12)
        Scroll(this.scroller) {
          Text(this.pages[this.page] ?? '').fontSize(18).lineHeight(30).fontColor(Tokens.text)
            .copyOption(CopyOptions.LocalDevice)
            .width('100%').constraintSize({ maxWidth: Tokens.readable }).padding(20)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
        Row({ space: 12 }) {
          ActionButton({ label: '上一页', variant: 'secondary', fullWidth: false, isEnabled: this.page > 0, onTap: () => this.move(-1) })
          Text(`${this.page + 1} / ${this.pages.length}`).fontSize(14).fontColor(Tokens.secondary)
          ActionButton({ label: '下一页', variant: 'secondary', fullWidth: false, isEnabled: this.page + 1 < this.pages.length, onTap: () => this.move(1) })
        }.padding(12)
      }.width('100%').height('100%').backgroundColor(Tokens.bg)
    }.hideTitleBar(true).onShown(() => AppNavigation.changed())
  }
}
