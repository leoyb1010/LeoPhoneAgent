import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ScreenProbeStatusPage {
  @StorageProp('screenProbeError') error: string = '';
  build() {
    Column({ space: 16 }) {
      Text('私有屏幕诊断').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
      Text(this.error || '正在准备连接').fontSize(15).fontColor(Tokens.warn).copyOption(CopyOptions.InApp)
      Text('仅本项目模拟器。固定有效证书域名通过 App DNS 映射至 10.0.2.2，证书校验和 SNI 保持开启。')
        .fontSize(14).fontColor(Tokens.secondary)
    }.padding(28).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }
}
