import { common } from '@kit.AbilityKit';
import { memoryStore } from '../store/MemoryStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct MemoryPage {
  @State global: string = '';
  @State today: string = '';
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    memoryStore.load(ctx).then(() => {
      this.global = memoryStore.global;
      this.today = memoryStore.today;
    });
  }

  build() {
    Column() {
      Text('记忆')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 12 })
      Scroll() {
        Column() {
          Text('GLOBAL.md')
            .fontSize(13)
            .fontColor(Tokens.muted)
            .width('100%')
            .padding({ bottom: 6 })
          TextArea({ text: this.global, placeholder: '长期记住的事' })
            .onChange((value: string) => {
              this.global = value;
            })
            .height(160)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          Text('今日')
            .fontSize(13)
            .fontColor(Tokens.muted)
            .width('100%')
            .padding({ top: 16, bottom: 6 })
          Text(this.today.length > 0 ? this.today : '还没有今日记忆。对话里用 /remember。')
            .fontSize(14)
            .fontColor(Tokens.text)
            .width('100%')
          Button('保存 GLOBAL.md')
            .width('100%')
            .height(44)
            .margin({ top: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              const ctx = getContext(this) as common.UIAbilityContext;
              memoryStore.saveGlobal(ctx, this.global).then(() => {
                this.message = '已保存';
              }).catch((err: Error) => {
                this.message = `${err}`;
              });
            })
          if (this.message.length > 0) {
            Text(this.message)
              .fontColor(Tokens.online)
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
