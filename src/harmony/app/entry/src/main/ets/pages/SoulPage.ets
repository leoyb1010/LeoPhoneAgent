import { common } from '@kit.AbilityKit';
import { soulStore } from '../store/SoulStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct SoulPage {
  @StorageProp('themeTick') tick: number = 0;
  @State text: string = '';
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    soulStore.load(ctx).then(() => {
      this.text = soulStore.text;
    });
  }

  build() {
    Column() {
      Text('Soul')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('SOUL.md 会注入本机对话，用来写你是谁、默认怎么做事。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      TextArea({ text: this.text, placeholder: '你是谁，默认风格，不能做什么' })
        .onChange((value: string) => {
          this.text = value;
        })
        .layoutWeight(1)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
        .backgroundColor(Tokens.surface)
        .fontColor(Tokens.text)
        .borderRadius(Tokens.settingsRadius)
      Button('保存 SOUL.md')
        .width('100%')
        .height(44)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 24 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .onClick(() => {
          const ctx = getContext(this) as common.UIAbilityContext;
          soulStore.save(ctx, this.text).then(() => {
            this.message = '已保存';
          }).catch((err: Error) => {
            this.message = `${err}`;
          });
        })
      if (this.message.length > 0) {
        Text(this.message)
          .fontColor(Tokens.online)
          .margin({ bottom: 16 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
