import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { DEFAULT_API_ROOT } from '../net/Protocol';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { gatewayStore } from '../store/GatewayStore';

@Entry
@Component
struct SettingsPage {
  @State apiRoot: string = DEFAULT_API_ROOT;
  @State keyDraft: string = '';
  @State message: string = '';

  aboutToAppear(): void {
    this.apiRoot = gatewayStore.apiRoot;
    this.keyDraft = gatewayStore.key;
  }

  build() {
    Column() {
      Text('设置')
        .fontSize(22)
        .fontColor('#F2F2F4')
        .width('100%')
        .padding({ left: 20, top: 20, bottom: 12 })

      Text('中继根')
        .fontSize(13)
        .fontColor('#8E8E93')
        .width('100%')
        .padding({ left: 20, bottom: 6 })
      TextInput({ text: this.apiRoot })
        .onChange((value: string) => {
          this.apiRoot = value;
        })
        .backgroundColor('#1C1C1E')
        .fontColor('#F2F2F4')
        .margin({ left: 16, right: 16, bottom: 12 })

      Text('中继钥匙')
        .fontSize(13)
        .fontColor('#8E8E93')
        .width('100%')
        .padding({ left: 20, bottom: 6 })
      TextInput({ text: this.keyDraft, placeholder: '至少 16 位，不会写进配对码' })
        .onChange((value: string) => {
          this.keyDraft = value;
        })
        .backgroundColor('#1C1C1E')
        .fontColor('#F2F2F4')
        .placeholderColor('#6E6E73')
        .margin({ left: 16, right: 16, bottom: 12 })

      Button('保存')
        .width('90%')
        .backgroundColor('#E85030')
        .fontColor('#FFFFFF')
        .onClick(() => {
          this.save();
        })

      if (this.message.length > 0) {
        Text(this.message)
          .fontColor('#30D158')
          .margin({ top: 10 })
      }

      Text(`版本 ${ReleaseCatalog.currentVersion} (${ReleaseCatalog.currentBuild})`)
        .fontColor('#8E8E93')
        .margin({ top: 28 })
      Text('本机 Agent 与鸿蒙当身体尚未交付。杀进程后审批不可用。')
        .fontSize(13)
        .fontColor('#8E8E93')
        .padding({ left: 20, right: 20, top: 8 })
      Text('查看本次更新')
        .fontColor('#E85030')
        .margin({ top: 16 })
        .onClick(() => {
          router.pushUrl({ url: 'pages/ReleaseNotesPage' });
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#121214')
  }

  private async save(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.apiRoot = this.apiRoot;
    gatewayStore.key = this.keyDraft;
    await gatewayStore.save(ctx);
    this.message = '已保存';
  }
}
