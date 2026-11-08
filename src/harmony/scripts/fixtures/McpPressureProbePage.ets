import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct McpPressureProbePage {
  @StorageProp('mcpPressureStatus') status: string = '';
  build() {
    Column({ space: 20 }) {
      Text('MCP 原生生命周期诊断').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
      Text(this.status || '正在准备').fontSize(15).fontColor(Tokens.secondary).width('100%')
      Text('固定本机guest测试进程。生产McpStdio与LinuxRuntime未替换，计数来自同一NAPI实例。')
        .fontSize(13).fontColor(Tokens.muted).width('100%')
    }.padding(28).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }
}
