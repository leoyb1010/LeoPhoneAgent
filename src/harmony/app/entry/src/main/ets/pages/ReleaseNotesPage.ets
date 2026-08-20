import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ReleaseNotesPage {
  build() {
    Scroll() {
      Column() {
        Text('本次更新')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
        Text(ReleaseCatalog.all()[0].title)
          .fontSize(22)
          .fontColor(Tokens.text)
          .margin({ top: 8, bottom: 16 })
          .width('100%')
        ForEach(ReleaseCatalog.all()[0].highlights, (line: string) => {
          Text(line)
            .fontSize(15)
            .fontColor('#D1D1D6')
            .margin({ bottom: 10 })
            .width('100%')
        }, (line: string) => line)
      }
      .padding(20)
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .align(Alignment.Top)
  }
}
