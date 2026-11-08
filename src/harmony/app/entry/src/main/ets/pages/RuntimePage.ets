import { AppNavigation } from '../navigation/AppNavigation';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';

import { PushRegistrar } from '../push/PushRegistrar';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct RuntimePage {
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
    NavDestination() {
    Scroll() {
      Column() {
        NavBar({ title: '本机运行时' })
        Text('查看本机权限和连接状态，系统能力按当前设备支持情况显示。')
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
        this.card('系统智能体与分享', '通过系统授权入口交互，查看已配置能力和运行状态', '查看系统集成', () => {
          AppNavigation.pushUrl({ url: 'pages/SystemIntegrationPage' });
        })
        this.card('本机 Linux', 'App 内置 iSH ARM64 解释器与 Alpine Linux，共享文件位于 /mnt/workspace。首次打开会安装并校验资源。', '打开终端', () => {
          AppNavigation.pushUrl({ url: 'pages/TerminalPage' });
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
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
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

}
