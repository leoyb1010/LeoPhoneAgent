import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct RecoveryPage {
  @StorageProp('startupRecoveryError') message: string = '备份恢复未完成';
  build() {
    Column({ space: 16 }) {
      Text('需要恢复数据').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
      Text(this.message).fontSize(16).fontColor(Tokens.text)
      Text('请保留备份和当前数据，检查恢复记录后重新打开应用。').fontSize(14).fontColor(Tokens.secondary)
    }.padding(28).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }
}
