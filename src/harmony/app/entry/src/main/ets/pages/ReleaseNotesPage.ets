import { LeoRelease, ReleaseCatalog } from '../release/ReleaseCatalog';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

/** 更新记录:每一版改了什么(最新的在最上面)。 */
@Entry
@Component
struct ReleaseNotesPage {
  @StorageProp('themeTick') tick: number = 0;

  build() {
    Column() {
      NavBar({ title: '更新记录' })
      Scroll() {
        Column() {
          ForEach(ReleaseCatalog.all(), (release: LeoRelease, index: number) => {
            Column() {
              Row() {
                Text(release.version)
                  .fontSize(13)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(index === 0 ? Tokens.accent : Tokens.secondary)
                Text(release.date)
                  .fontSize(13)
                  .fontColor(Tokens.muted)
                  .margin({ left: 8 })
              }
              Text(release.title)
                .fontSize(index === 0 ? 20 : 17)
                .fontWeight(FontWeight.Bold)
                .fontColor(Tokens.text)
                .margin({ top: 4, bottom: 10 })
              ForEach(release.highlights, (line: string) => {
                Row() {
                  Column()
                    .width(5)
                    .height(5)
                    .borderRadius(2.5)
                    .backgroundColor(index === 0 ? Tokens.accent : Tokens.muted)
                    .margin({ top: 9 })
                  Text(line)
                    .fontSize(15)
                    .lineHeight(23)
                    .fontColor(Tokens.text)
                    .margin({ left: 10 })
                    .layoutWeight(1)
                }
                .width('100%')
                .alignItems(VerticalAlign.Top)
                .margin({ bottom: 8 })
              }, (line: string) => line)
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding(16)
            .backgroundColor(Tokens.card)
            .borderRadius(Tokens.groupRadius)
            .margin({ bottom: 12 })
          }, (release: LeoRelease) => release.version)
        }
        .width('100%')
        .constraintSize({ maxWidth: Tokens.readable })
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 4, bottom: 32 })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.grouped)
  }
}
