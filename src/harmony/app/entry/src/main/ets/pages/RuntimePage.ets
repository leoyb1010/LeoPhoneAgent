import { abilityAccessCtrl, common, Permissions, Want } from '@kit.AbilityKit';
import { PushRegistrar } from '../push/PushRegistrar';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct RuntimePage {
  @StorageProp('themeTick') tick: number = 0;
  @State pushLine: string = '';
  @State micLine: string = '还没问麦克风';
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    PushRegistrar.bind(ctx).then(() => {
      this.pushLine = PushRegistrar.line();
    });
  }

  build() {
    Scroll() {
      Column() {
        Text('本机运行时')
          .fontSize(Tokens.title)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
          .width('100%')
          .padding({ bottom: 8 })
        Text('OAuth、语音、Push 在这一页接。Linux / stdio MCP 受鸿蒙进程模型挡住，不是先不做。')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ bottom: 16 })
        this.card('语音', this.micLine, '申请麦克风', () => {
          this.askMic();
        })
        this.card('杀进程后推送', this.pushLine, '重新要 token', () => {
          this.refreshPush();
        })
        this.card('无障碍', '打开系统无障碍，把 Leo 打开后才能点其他应用', '去系统设置', () => {
          this.openA11y();
        })
        this.card('Linux / stdio MCP', '鸿蒙 NEXT 跑不了 Android 那份 PRoot ELF，也拉不起 npx 进程。沙箱文件和 HTTP MCP 能用。', '', () => {
        })
        if (this.message.length > 0) {
          Text(this.message)
            .fontSize(13)
            .fontColor(Tokens.warn)
            .padding({ top: 12 })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .scrollBar(BarState.Off)
  }

  @Builder
  card(title: string, body: string, action: string, tap: () => void) {
    Column() {
      Text(title)
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.text)
      Text(body)
        .fontSize(13)
        .fontColor(Tokens.muted)
        .margin({ top: 6 })
      if (action.length > 0) {
        Text(action)
          .fontSize(13)
          .fontColor(Tokens.link)
          .margin({ top: 10 })
          .onClick(tap)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .margin({ bottom: 8 })
    .backgroundColor(Tokens.surface)
    .borderRadius(Tokens.settingsRadius)
  }

  private async askMic(): Promise<void> {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const at = abilityAccessCtrl.createAtManager();
      const perm: Permissions = 'ohos.permission.MICROPHONE';
      await at.requestPermissionsFromUser(ctx, [perm]);
      this.micLine = '已向系统申请麦克风，对话里用「说」';
    } catch (err) {
      this.micLine = `${err}`;
    }
  }

  private async refreshPush(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await PushRegistrar.bind(ctx);
    this.pushLine = PushRegistrar.line();
  }

  private async openA11y(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const first: Want = {
      action: 'ohos.settings.accessibility'
    };
    try {
      await ctx.startAbility(first);
      return;
    } catch (_err) {
      // try the settings bundle
    }
    const second: Want = {
      bundleName: 'com.huawei.hmos.settings',
      uri: 'accessibility://'
    };
    try {
      await ctx.startAbility(second);
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
