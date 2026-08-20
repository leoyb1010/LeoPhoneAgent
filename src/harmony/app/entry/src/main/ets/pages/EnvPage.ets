import { common } from '@kit.AbilityKit';
import { EnvEntry, envStore } from '../store/EnvStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct EnvPage {
  @StorageProp('themeTick') tick: number = 0;
  @State nameDraft: string = '';
  @State valueDraft: string = '';
  @State rows: EnvEntry[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    envStore.load(ctx).then(() => {
      this.rows = envStore.rows.slice();
    });
  }

  build() {
    Column() {
      Text('环境变量')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('注入本机对话。没有 Linux 进程环境，只给模型看。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.nameDraft, placeholder: 'NAME' })
            .onChange((value: string) => {
              this.nameDraft = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          TextInput({ text: this.valueDraft, placeholder: 'value' })
            .onChange((value: string) => {
              this.valueDraft = value;
            })
            .height(44)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.settingsRadius)
          Button('保存变量')
            .width('100%')
            .height(44)
            .margin({ top: 10, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.save();
            })
          ForEach(this.rows, (row: EnvEntry) => {
            Row() {
              Column() {
                Text(row.name)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(row.value)
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
                  this.drop(row.name);
                })
            }
            .width('100%')
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: EnvEntry) => row.name)
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
      await envStore.upsert(ctx, this.nameDraft, this.valueDraft);
      this.rows = envStore.rows.slice();
      this.nameDraft = '';
      this.valueDraft = '';
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async drop(name: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await envStore.remove(ctx, name);
      this.rows = envStore.rows.slice();
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
