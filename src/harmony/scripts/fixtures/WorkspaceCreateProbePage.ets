import { Tokens } from '../theme/Tokens';
@Entry
@Component
struct WorkspaceCreateProbePage {
  @StorageProp('workspaceCreateProbeStatus') status: string = '';
  build() {
    Column({ space: 18 }) {
      Text('原生独占创建微探针').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
      Text(this.status || '正在验证').fontSize(14).fontColor(Tokens.secondary).width('100%')
    }.padding(28).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }
}
