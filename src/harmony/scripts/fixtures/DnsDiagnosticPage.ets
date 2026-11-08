import { Tokens } from '../theme/Tokens';
@Entry
@Component
struct DnsDiagnosticPage {
  @StorageProp('dnsDiagnostic') status: string = '';
  build() { Column({ space: 16 }) { Text('本机 Linux DNS 诊断').fontSize(24).fontColor(Tokens.text)
    Text(this.status || '正在读取').fontSize(14).fontColor(Tokens.secondary).width('100%')
  }.padding(28).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg) }
}
