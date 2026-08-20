import { common } from '@kit.AbilityKit';
import { bodyStore } from '../store/BodyStore';
import { gatewayStore } from '../store/GatewayStore';
import { outboundClient, startBody } from '../net/OutboundClient';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct BodyPage {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('bodyTick') bodyTick: number = 0;
  @State on: boolean = false;
  @State name: string = 'LeoHarmony';
  @State pair: string = '';
  @State line: string = '';
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    Promise.all([
      gatewayStore.ensureLoaded(ctx),
      bodyStore.load(ctx)
    ]).then(() => {
      this.on = bodyStore.on;
      this.name = bodyStore.name;
      this.pair = bodyStore.pairCode();
      this.line = bodyStore.online ? '在线，iPhone 能指挥这台机' : '离线';
    });
  }

  build() {
    Scroll() {
      Column() {
        Text('当身体')
          .fontSize(Tokens.title)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
          .width('100%')
          .padding({ bottom: 8 })
        Text('打开后向中继注册 platform=harmony。iPhone 列表会出现这台机。Push token 在「本机运行时」。')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ bottom: 16 })
        Row() {
          Text('作为身体上线')
            .fontSize(Tokens.rowTitle)
            .fontColor(Tokens.text)
            .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.on })
            .onChange((on: boolean) => {
              this.on = on;
              this.save();
            })
        }
        .width('100%')
        .padding(14)
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        Text('身体名')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .padding({ top: 16, bottom: 6 })
        TextInput({ text: this.name })
          .onChange((value: string) => {
            this.name = value;
          })
          .height(44)
          .backgroundColor(Tokens.surface)
          .fontColor(Tokens.text)
          .borderRadius(Tokens.settingsRadius)
        Text(this.bodyTick >= 0 && bodyStore.online ? '在线，iPhone 能指挥这台机' : this.line)
          .fontSize(13)
          .fontColor(bodyStore.online ? Tokens.online : Tokens.muted)
          .padding({ top: 12 })
        Text('配对码（没有钥匙）')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .padding({ top: 16, bottom: 6 })
        Text(this.pair)
          .fontSize(12)
          .fontColor(Tokens.text)
          .width('100%')
          .padding(14)
          .backgroundColor(Tokens.surface)
          .borderRadius(Tokens.settingsRadius)
        Text('杀进程后审批不可用。被指挥需要应用在前台。')
          .fontSize(13)
          .fontColor(Tokens.warn)
          .padding({ top: 16 })
        Button('保存并连接')
          .width('100%')
          .height(44)
          .margin({ top: 16 })
          .backgroundColor(Tokens.accent)
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.save();
          })
        if (this.message.length > 0) {
          Text(this.message)
            .fontColor(this.message === '已保存' ? Tokens.online : Tokens.warn)
            .padding({ top: 10 })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  private save(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    bodyStore.on = this.on;
    bodyStore.name = this.name;
    bodyStore.save(ctx).then(() => {
      this.pair = bodyStore.pairCode();
      this.message = '已保存';
      if (this.on) {
        startBody(ctx);
        this.line = '正在注册';
      } else {
        outboundClient.stop();
        this.line = '已关闭';
      }
    }).catch((err: Error) => {
      this.message = `${err}`;
    });
  }
}
