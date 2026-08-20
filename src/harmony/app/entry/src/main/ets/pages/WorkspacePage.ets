import { common } from '@kit.AbilityKit';
import { WorkspaceFile, WorkspaceStore } from '../store/WorkspaceStore';
import { Copy } from '../theme/Copy';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct WorkspacePage {
  @State rows: WorkspaceFile[] = [];
  @State preview: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.rows = WorkspaceStore.list(ctx);
  }

  build() {
    Column() {
      Text('沙箱文件')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text(Copy.noLinux)
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      Scroll() {
        Column() {
          if (this.rows.length === 0) {
            Text('还没有沙箱文件。对话里用 /write 文件名 内容。')
              .fontSize(14)
              .fontColor(Tokens.muted)
          }
          ForEach(this.rows, (row: WorkspaceFile) => {
            Row() {
              Text(row.name)
                .fontSize(Tokens.rowTitle)
                .fontColor(Tokens.text)
                .layoutWeight(1)
              Text(`${row.size}`)
                .fontSize(12)
                .fontColor(Tokens.muted)
            }
            .width('100%')
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
            .onClick(() => {
              const ctx = getContext(this) as common.UIAbilityContext;
              try {
                this.preview = WorkspaceStore.read(ctx, row.name);
              } catch (err) {
                this.preview = `${err}`;
              }
            })
          }, (row: WorkspaceFile) => row.name)
          if (this.preview.length > 0) {
            Text(this.preview)
              .fontSize(14)
              .fontColor(Tokens.text)
              .margin({ top: 8 })
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
}
