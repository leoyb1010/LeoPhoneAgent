import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct StartupPage {
  build() {
    Column({ space: 16 }) {
      Image($r('app.media.leobot_mark')).width(56).height(56).objectFit(ImageFit.Contain).accessibilityText('LeoBot')
      Text('正在准备本机资料').fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
      Text('如有待完成的恢复，资料准备好后会自动打开。').fontSize(14).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
    }.padding(32).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }
}
