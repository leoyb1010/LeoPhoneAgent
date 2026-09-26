import { common } from '@kit.AbilityKit';
import { McpServer, mcpStore } from '../store/McpStore';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct McpPage {
  @StorageProp('themeTick') tick: number = 0;
  @State nameDraft: string = '';
  @State urlDraft: string = '';
  @State secretDraft: string = '';
  @State rows: McpServer[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    mcpStore.load(ctx).then(() => {
      this.rows = mcpStore.rows.slice();
    });
  }

  build() {
    Column() {
      NavBar({ title: 'MCP' })
      Text('远程 MCP 服务器(Streamable HTTP)。保存时握手并拉工具清单;钥匙可以写成 $$变量名,真值放「环境变量」。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.nameDraft, placeholder: '名称' })
            .onChange((value: string) => {
              this.nameDraft = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          TextInput({ text: this.urlDraft, placeholder: 'https://...' })
            .onChange((value: string) => {
              this.urlDraft = value;
            })
            .height(44)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          TextInput({ text: this.secretDraft, placeholder: '可选钥匙(Bearer),如 $$ZHIPU_API_KEY' })
            .onChange((value: string) => {
              this.secretDraft = value;
            })
            .height(44)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          Button('保存并拉工具')
            .width('100%')
            .height(44)
            .margin({ top: 10, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.save();
            })
          // 和 iOS 同一个预设:智谱的网页搜索 MCP。钥匙在「环境变量」里填 ZHIPU_API_KEY。
          Text('+ 智谱网页搜索(预设)')
            .fontSize(14)
            .fontColor(Tokens.accent)
            .margin({ bottom: 16 })
            .onClick(() => {
              this.nameDraft = 'zhipu-web-search';
              this.urlDraft = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
              this.secretDraft = '$$ZHIPU_API_KEY';
              this.message = '在「环境变量」里加 ZHIPU_API_KEY,再点「保存并拉工具」';
            })
          ForEach(this.rows, (row: McpServer) => {
            Row() {
              Column() {
                Text(row.label)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(row.tools.length > 0 ? row.tools : row.url)
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text('删除')
                .fontSize(13)
                .fontColor(Tokens.accent)
                .onClick(() => {
                  this.drop(row.label);
                })
            }
            .width('100%')
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: McpServer) => row.label)
          if (this.message.length > 0) {
            Text(this.message)
              .fontColor(this.message === '已保存' ? Tokens.online : Tokens.warn)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 32 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  private async save(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await mcpStore.upsert(ctx, this.nameDraft, this.urlDraft, this.secretDraft);
      this.rows = mcpStore.rows.slice();
      this.nameDraft = '';
      this.urlDraft = '';
      this.secretDraft = '';
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async drop(label: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await mcpStore.remove(ctx, label);
      this.rows = mcpStore.rows.slice();
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
