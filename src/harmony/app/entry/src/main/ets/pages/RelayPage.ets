import { common } from '@kit.AbilityKit';
import { DEFAULT_API_ROOT, requireHttpsRoot, sanitizeKey } from '../net/Protocol';
import { gatewayStore } from '../store/GatewayStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct RelayPage {
  @StorageProp('themeTick') tick: number = 0;
  @State apiRoot: string = DEFAULT_API_ROOT;
  @State keyDraft: string = '';
  @State message: string = '';
  @State ready: boolean = false;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.ensureLoaded(ctx).then(() => {
      this.apiRoot = gatewayStore.apiRoot;
      this.keyDraft = gatewayStore.key;
      this.ready = true;
    }).catch((err: Error) => {
      this.message = `${err}`;
    });
  }

  build() {
    Column() {
      Text('中继')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('远程机器走这条中继。钥匙至少 16 位，不会写进配对码。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 16 })
      Column() {
        Text('中继根')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ bottom: 6 })
        TextInput({ text: this.apiRoot })
          .onChange((value: string) => {
            this.apiRoot = value;
          })
          .height(44)
          .backgroundColor(Tokens.bg)
          .fontColor(Tokens.text)
          .borderRadius(Tokens.settingsRadius)
          .margin({ bottom: 12 })
        Text('中继钥匙')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ bottom: 6 })
        TextInput({ text: this.keyDraft, placeholder: '至少 16 位' })
          .onChange((value: string) => {
            this.keyDraft = value;
          })
          .type(InputType.Password)
          .height(44)
          .backgroundColor(Tokens.bg)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(Tokens.settingsRadius)
      }
      .width('100%')
      .padding(14)
      .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
      .backgroundColor(Tokens.surface)
      .borderRadius(Tokens.settingsRadius)
      Button(this.ready ? '保存中继' : '读取中')
        .width('100%')
        .height(44)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad, top: 16 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .enabled(this.ready)
        .onClick(() => {
          this.save();
        })
      if (this.message.length > 0) {
        Text(this.message)
          .fontColor(this.message === '已保存' ? Tokens.online : Tokens.warn)
          .margin({ top: 12 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  private async save(): Promise<void> {
    if (!this.ready) {
      this.message = '正在读取本地设置';
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    await gatewayStore.ensureLoaded(ctx);
    const key = sanitizeKey(this.keyDraft);
    if (key.length > 0 && key.length < 16) {
      this.message = '钥匙至少 16 位';
      return;
    }
    try {
      const root = requireHttpsRoot(this.apiRoot);
      gatewayStore.apiRoot = root;
      if (key.length >= 16) {
        gatewayStore.key = key;
      }
      await gatewayStore.save(ctx);
      this.apiRoot = root;
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
