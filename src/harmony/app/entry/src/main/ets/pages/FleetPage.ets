import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { HarnessKind, displayName } from '../net/Protocol';
import { MachinesClient } from '../net/MachinesClient';
import { ChatLaunch, HarnessClient } from '../net/HarnessClient';
import { gatewayStore, SavedHost } from '../store/GatewayStore';

@Entry
@Component
struct FleetPage {
  @State keyDraft: string = '';
  @State pairDraft: string = '';
  @State message: string = '';
  @State hosts: SavedHost[] = [];
  @State busy: boolean = false;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.load(ctx).then(() => {
      this.keyDraft = gatewayStore.key;
      this.hosts = gatewayStore.hosts.slice();
    });
  }

  build() {
    Column() {
      Text('远程机器')
        .fontSize(22)
        .fontColor('#F2F2F4')
        .width('100%')
        .padding({ left: 20, right: 20, top: 20, bottom: 8 })

      TextInput({ placeholder: '中继钥匙（至少 16 位）', text: this.keyDraft })
        .onChange((value: string) => {
          this.keyDraft = value;
        })
        .backgroundColor('#1C1C1E')
        .fontColor('#F2F2F4')
        .placeholderColor('#6E6E73')
        .margin({ left: 16, right: 16, bottom: 8 })

      Row() {
        Button('保存钥匙')
          .layoutWeight(1)
          .backgroundColor('#2C2C2E')
          .fontColor('#F2F2F4')
          .onClick(() => {
            this.saveKey();
          })
        Button(this.busy ? '刷新中' : '刷新')
          .layoutWeight(1)
          .backgroundColor('#E85030')
          .fontColor('#FFFFFF')
          .margin({ left: 8 })
          .enabled(!this.busy)
          .onClick(() => {
            this.refresh();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 12 })

      TextInput({ placeholder: '粘贴身体配对码', text: this.pairDraft })
        .onChange((value: string) => {
          this.pairDraft = value;
        })
        .backgroundColor('#1C1C1E')
        .fontColor('#F2F2F4')
        .placeholderColor('#6E6E73')
        .margin({ left: 16, right: 16, bottom: 8 })

      Button('加入')
        .width('90%')
        .backgroundColor('#2C2C2E')
        .fontColor('#F2F2F4')
        .onClick(() => {
          this.joinPair();
        })

      if (this.message.length > 0) {
        Text(this.message)
          .fontSize(13)
          .fontColor('#FF9F0A')
          .padding({ left: 20, right: 20, top: 10 })
      }

      if (this.hosts.length === 0) {
        Text('还没有在线的远程机器')
          .fontColor('#8E8E93')
          .margin({ top: 32 })
      } else {
        List() {
          ForEach(this.hosts, (host: SavedHost) => {
            ListItem() {
              Row() {
                Column() {
                  Text(host.displayName.length > 0 ? host.displayName : displayName(host.name))
                    .fontSize(16)
                    .fontColor('#F2F2F4')
                  Text(host.name + (host.platform.length > 0 ? ` · ${host.platform}` : ''))
                    .fontSize(12)
                    .fontColor('#8E8E93')
                    .margin({ top: 4 })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Text(host.online ? '在线' : '离线')
                  .fontSize(12)
                  .fontColor(host.online ? '#30D158' : '#8E8E93')
              }
              .width('100%')
              .padding(16)
            }
            .onClick(() => {
              this.openMachine(host);
            })
          }, (host: SavedHost) => host.name)
        }
        .layoutWeight(1)
        .margin({ top: 12 })
        .divider({ strokeWidth: 0.5, color: '#2C2C2E' })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#121214')
  }

  private async saveKey(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.key = this.keyDraft;
    await gatewayStore.save(ctx);
    this.message = '钥匙已保存';
  }

  private async joinPair(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.message = gatewayStore.scanPairCode(this.pairDraft);
    this.hosts = gatewayStore.hosts.slice();
    await gatewayStore.save(ctx);
  }

  private async refresh(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.key = this.keyDraft;
    await gatewayStore.save(ctx);
    this.busy = true;
    this.message = '';
    try {
      const live = await MachinesClient.list(gatewayStore.apiRoot, gatewayStore.key);
      gatewayStore.upsertDiscovered(live);
      this.hosts = gatewayStore.hosts.slice();
      await gatewayStore.save(ctx);
      if (live.length === 0) {
        this.message = '还没有在线的远程机器';
      }
    } catch (err) {
      this.message = `${err}`;
    } finally {
      this.busy = false;
    }
  }

  private async openMachine(host: SavedHost): Promise<void> {
    if (!host.online) {
      this.message = '这台机器现在离线';
      return;
    }
    let harness = 'minis';
    const discovered = gatewayStore.hosts.find((row: SavedHost) => row.name === host.name);
    const platform = discovered ? discovered.platform : host.platform;
    if (platform !== 'android' && platform !== 'harmony') {
      try {
        const client = new HarnessClient(gatewayStore.apiRoot, host.name, gatewayStore.key);
        const kinds: HarnessKind[] = await client.kinds();
        if (kinds.length > 0) {
          harness = kinds[0].key;
        }
      } catch (_err) {
        harness = 'claude';
      }
    }
    ChatLaunch.machine = host.name;
    ChatLaunch.harness = harness;
    router.pushUrl({ url: 'pages/RemoteChatPage' });
  }
}
