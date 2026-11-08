import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { kindByKey, providerKinds, ProviderKind } from '../local/ProviderCatalog';
import { ProviderInstance, ProviderLaunch, providerStore } from '../store/ProviderStore';
import { NavBar, SettingsRow } from '../theme/Widgets';
import { ActionButton } from '../theme/Controls';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ProviderListPage {
  @StorageProp('themeTick') tick: number = 0;
  @State ready: boolean = false;
  @State message: string = '';
  @State rows: ProviderInstance[] = [];

  aboutToAppear(): void { this.refresh(); }
  onPageShow(): void { this.refresh(); }

  build() {
    Column() {
      NavBar({ title: 'AI 服务商', action: '添加', onAction: () => router.pushUrl({ url: 'pages/AddProviderPage' }) })
      Scroll() {
        Column({ space: 12 }) {
          Text('连接模型与语音服务，密钥由设备钥匙串保管。').fontSize(14).lineHeight(22).fontColor(Tokens.secondary).width('100%')
          if (this.message) {
            Text(this.message).fontSize(14).fontColor(Tokens.warn).width('100%')
            ActionButton({ label: '重新读取', variant: 'secondary', fullWidth: false, onTap: () => this.refresh() })
          }
          if (!this.ready) {
            Text('正在读取服务商').fontSize(15).fontColor(Tokens.secondary).padding({ top: 40, bottom: 40 })
          } else if (!this.rows.length) {
            Column({ space: 12 }) {
              Sym({ name: 'globe_badge_message', dim: 36, color: Tokens.accent })
              Text('连接你的第一个模型').fontSize(22).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
              Text('选择服务商，登录账号或填写 API Key，随后选择执行模型。')
                .fontSize(15).lineHeight(24).fontColor(Tokens.secondary).textAlign(TextAlign.Center).constraintSize({ maxWidth: 380 })
              ActionButton({ label: '添加 AI 服务商', icon: 'plus', fullWidth: false,
                onTap: () => router.pushUrl({ url: 'pages/AddProviderPage' }) }).margin({ top: 12 })
            }.width('100%').padding({ top: 64, bottom: 48, left: 20, right: 20 })
          } else {
            ForEach(providerKinds(), (kind: ProviderKind) => {
              if (this.of(kind.key).length) {
                Text(kind.title).fontSize(13).fontColor(Tokens.secondary).width('100%').margin({ top: 16 })
                Column() {
                  ForEach(this.of(kind.key), (item: ProviderInstance, index: number) => {
                    SettingsRow({ mark: kindByKey(item.type).mark, color: kindByKey(item.type).color,
                      title: item.label || kindByKey(item.type).title,
                      subtitle: `${item.credential === 'oauth' ? 'OAuth' : 'API Key'} · ${item.model || '待选择模型'} · ${item.enabled ? '已启用' : '已关闭'}${providerStore.activeId === item.id ? ' · 当前' : ''}`,
                      divider: index > 0, onOpen: () => { ProviderLaunch.id = item.id; router.pushUrl({ url: 'pages/ProviderDetailPage' }); } })
                  }, (item: ProviderInstance) => `${item.id}|${item.label}|${item.model}|${item.enabled}|${providerStore.activeId === item.id}`)
                }.width('100%').backgroundColor(Tokens.card).borderRadius(16).clip(true)
              }
            }, (kind: ProviderKind) => kind.key)
          }
        }.width('100%').constraintSize({ maxWidth: 640 }).alignItems(HorizontalAlign.Start)
          .padding({ left: 20, right: 20, top: 16, bottom: 40 })
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)
  }

  private of(type: string): ProviderInstance[] { return this.rows.filter((item: ProviderInstance) => item.type === type); }
  private refresh(): void {
    const context = getContext(this) as common.UIAbilityContext;
    providerStore.ensureLoaded(context).then(() => {
      this.rows = providerStore.instances.slice(); this.ready = true;
      this.message = providerStore.jsonLoadFailed ? 'AI 服务商档案读取失败，请检查数据后再保存' : '';
    }).catch((error: Error) => { this.message = error.message; });
  }
}
