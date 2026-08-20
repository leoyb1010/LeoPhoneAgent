import { common } from '@kit.AbilityKit';
import { sessionStore } from '../store/SessionStore';
import { usageStore } from '../store/UsageStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct UsagePage {
  @StorageProp('themeTick') tick: number = 0;
  @State sessions: number = 0;
  @State pinned: number = 0;
  @State turns: number = 0;
  @State prompt: number = 0;
  @State completion: number = 0;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    Promise.all([sessionStore.ensureLoaded(ctx), usageStore.load(ctx)]).then(() => {
      const rows = sessionStore.listActive();
      this.sessions = rows.length;
      this.pinned = rows.filter((row) => row.pinned).length;
      this.turns = usageStore.turns;
      this.prompt = usageStore.prompt;
      this.completion = usageStore.completion;
    });
  }

  build() {
    Column() {
      Text('用量')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('本机只统计这台鸿蒙上的会话和 token。没有云端账单。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 16 })
      Column() {
        this.stat('本机会话', `${this.sessions}`)
        this.stat('置顶', `${this.pinned}`)
        this.stat('本机回合', `${this.turns}`)
        this.stat('输入 token', `${this.prompt}`)
        this.stat('输出 token', `${this.completion}`)
      }
      .width('100%')
      .backgroundColor(Tokens.surface)
      .borderRadius(Tokens.settingsRadius)
      .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  stat(title: string, value: string) {
    Row() {
      Text(title)
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.text)
        .layoutWeight(1)
      Text(value)
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.muted)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 14, bottom: 14 })
  }
}
