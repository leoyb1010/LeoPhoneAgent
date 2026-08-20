import { common } from '@kit.AbilityKit';
import { ScheduleStore, ScheduleTask, scheduleStore } from '../store/ScheduleStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct SchedulePage {
  @StorageProp('themeTick') tick: number = 0;
  @State titleDraft: string = '';
  @State promptDraft: string = '';
  @State hourDraft: string = '9';
  @State minuteDraft: string = '0';
  @State rows: ScheduleTask[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    scheduleStore.load(ctx).then(() => {
      this.rows = scheduleStore.rows.slice();
    });
  }

  build() {
    Column() {
      Text('定时任务')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('目前仅 App 在前台时执行。锁屏、切后台或杀进程都不会跑。结果写入「定时·标题」会话，失败原因也在下面。')
        .fontSize(13)
        .fontColor(Tokens.warn)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.titleDraft, placeholder: '标题' })
            .onChange((value: string) => {
              this.titleDraft = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          TextInput({ text: this.promptDraft, placeholder: '到点要说的话' })
            .onChange((value: string) => {
              this.promptDraft = value;
            })
            .height(44)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          Row() {
            TextInput({ text: this.hourDraft, placeholder: '时' })
              .onChange((value: string) => {
                this.hourDraft = value;
              })
              .layoutWeight(1)
              .height(44)
              .backgroundColor(Tokens.surface)
              .fontColor(Tokens.text)
              .borderRadius(Tokens.settingsRadius)
            TextInput({ text: this.minuteDraft, placeholder: '分' })
              .onChange((value: string) => {
                this.minuteDraft = value;
              })
              .layoutWeight(1)
              .height(44)
              .margin({ left: 8 })
              .backgroundColor(Tokens.surface)
              .fontColor(Tokens.text)
              .borderRadius(Tokens.settingsRadius)
          }
          .width('100%')
          .margin({ top: 8 })
          Button('保存任务')
            .width('100%')
            .height(44)
            .margin({ top: 10, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.save();
            })
          ForEach(this.rows, (row: ScheduleTask) => {
            Row() {
              Column() {
                Text(row.title)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(`${row.hour}:${row.minute < 10 ? '0' : ''}${row.minute} · ${row.prompt}`)
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
                Text(ScheduleStore.runLabel(row))
                  .fontSize(12)
                  .fontColor(row.lastError.length > 0 ? Tokens.warn : Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text('删除')
                .fontSize(13)
                .fontColor(Tokens.accent)
                .onClick(() => {
                  this.drop(row.rowId);
                })
            }
            .width('100%')
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: ScheduleTask) => row.rowId)
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
      await scheduleStore.upsert(ctx, this.titleDraft, this.promptDraft, Number(this.hourDraft),
        Number(this.minuteDraft));
      this.rows = scheduleStore.rows.slice();
      this.titleDraft = '';
      this.promptDraft = '';
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async drop(rowId: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await scheduleStore.remove(ctx, rowId);
      this.rows = scheduleStore.rows.slice();
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
