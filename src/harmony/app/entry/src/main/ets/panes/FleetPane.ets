import { common } from '@kit.AbilityKit';
import { HarnessKind, displayName, sanitizeKey } from '../net/Protocol';
import { MachinesClient } from '../net/MachinesClient';
import { ChatLaunch, HarnessClient } from '../net/HarnessClient';
import { gatewayStore, SavedHost } from '../store/GatewayStore';
import { IconCircle } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct FleetPane {
  @Prop wide: boolean = false;
  onOpen: () => void = () => {};
  onLocal: () => void = () => {};
  onSettings: () => void = () => {};
  @State keyDraft: string = '';
  @State pairDraft: string = '';
  @State message: string = '';
  @State hosts: SavedHost[] = [];
  @State busy: boolean = false;
  @State ready: boolean = false;
  @State setupOpen: boolean = true;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.ensureLoaded(ctx).then(() => {
      this.keyDraft = gatewayStore.key;
      this.hosts = gatewayStore.hosts.slice();
      this.ready = true;
      this.setupOpen = sanitizeKey(gatewayStore.key).length < 16;
    }).catch((err: Error) => {
      this.message = `${err}`;
    });
  }

  build() {
    Column() {
      Row() {
        if (this.wide) {
          Text('远程')
            .fontSize(Tokens.title)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text)
        }
        Blank()
        Text(this.busy ? '刷新中' : '刷新')
          .fontSize(15)
          .fontColor(this.ready && !this.busy ? Tokens.accent : Tokens.muted)
          .onClick(() => {
            if (this.ready && !this.busy) {
              this.refresh();
            }
          })
        if (this.wide) {
          Text('本机')
            .fontSize(14)
            .fontColor(Tokens.muted)
            .margin({ left: 14 })
            .onClick(() => {
              this.onLocal();
            })
          Text('设置')
            .fontSize(14)
            .fontColor(Tokens.accent)
            .margin({ left: 14 })
            .onClick(() => {
              this.onSettings();
            })
        }
      }
      .width('100%')
      .height(this.wide ? Tokens.topBar : 36)
      .alignItems(VerticalAlign.Center)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad })

      Scroll() {
        Column() {
          this.setupCard()
          if (this.message.length > 0) {
            Text(this.message)
              .fontSize(13)
              .fontColor(this.message === '钥匙已保存' || this.message.startsWith('已加入') ? Tokens.online : Tokens.warn)
              .width('100%')
              .padding({ left: 4, right: 4, top: 4, bottom: 12 })
          }
          if (this.hosts.length === 0) {
            this.emptyState()
          } else {
            ForEach(this.hosts, (host: SavedHost) => {
              this.machineCard(host)
            }, (host: SavedHost) => host.name)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: 24 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  setupCard() {
    Column() {
      Row() {
        Text('中继')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
        Blank()
        Text(this.setupOpen ? '收起' : '展开')
          .fontSize(13)
          .fontColor(Tokens.accent)
      }
      .width('100%')
      .onClick(() => {
        this.setupOpen = !this.setupOpen;
      })
      if (this.setupOpen) {
        Text('钥匙至少 16 位，不会写进配对码')
          .fontSize(12)
          .fontColor(Tokens.muted)
          .width('100%')
          .margin({ top: 8, bottom: 10 })
        TextInput({ placeholder: '中继钥匙', text: this.keyDraft })
          .onChange((value: string) => {
            this.keyDraft = value;
          })
          .type(InputType.Password)
          .height(44)
          .backgroundColor(Tokens.bg)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(10)
        Button('保存钥匙')
          .width('100%')
          .height(40)
          .margin({ top: 8 })
          .backgroundColor(Tokens.surface2)
          .fontColor(Tokens.text)
          .enabled(this.ready)
          .onClick(() => {
            this.saveKey();
          })
        TextInput({ placeholder: '粘贴身体配对码', text: this.pairDraft })
          .onChange((value: string) => {
            this.pairDraft = value;
          })
          .height(44)
          .margin({ top: 12 })
          .backgroundColor(Tokens.bg)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(10)
        Button('加入')
          .width('100%')
          .height(40)
          .margin({ top: 8 })
          .backgroundColor(Tokens.surface2)
          .fontColor(Tokens.text)
          .enabled(this.ready)
          .onClick(() => {
            this.joinPair();
          })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(Tokens.pagePad)
    .margin({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 14 })
    .backgroundColor(Tokens.surface)
    .borderRadius(Tokens.cardRadius)
  }

  @Builder
  emptyState() {
    Column() {
      Text('还没有远程机器')
        .fontSize(18)
        .fontColor(Tokens.text)
      Text('保存中继钥匙后点刷新。也可以粘贴身体配对码加入一台离线机器。')
        .fontSize(14)
        .fontColor(Tokens.muted)
        .margin({ top: 8 })
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ top: 48, bottom: 32, left: 12, right: 12 })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  machineCard(host: SavedHost) {
    Row() {
      IconCircle({
        color: host.online ? Tokens.online : Tokens.muted,
        icon: host.platform === 'android' ? 'phone' : (host.platform === 'harmony' ? 'pad' : 'laptop')
      })
      Column() {
        Text(host.displayName.length > 0 ? host.displayName : displayName(host.name))
          .fontSize(Tokens.rowTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${host.platform.length > 0 ? host.platform : 'mac'} · ${host.name}`)
          .fontSize(Tokens.rowSub)
          .fontColor(Tokens.muted)
          .margin({ top: 1 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: Tokens.rowGap })
      .layoutWeight(1)
      Text(host.online ? '在线' : '离线')
        .fontSize(Tokens.time)
        .fontColor(host.online ? Tokens.online : Tokens.muted)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({
      left: Tokens.rowHPad,
      right: Tokens.rowHPad,
      top: Tokens.rowVPad,
      bottom: Tokens.rowVPad
    })
    .margin({ bottom: 0 })
    .backgroundColor(Tokens.surface)
    .borderRadius(0)
    .onClick(() => {
      this.openMachine(host);
    })
  }

  private async saveKey(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await gatewayStore.ensureLoaded(ctx);
    const key = sanitizeKey(this.keyDraft);
    if (key.length < 16) {
      this.message = '钥匙至少 16 位';
      return;
    }
    gatewayStore.key = key;
    try {
      await gatewayStore.save(ctx);
      this.message = '钥匙已保存';
      this.setupOpen = false;
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async joinPair(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await gatewayStore.ensureLoaded(ctx);
    this.message = await gatewayStore.scanPairCode(this.pairDraft);
    this.hosts = gatewayStore.hosts.slice();
    await gatewayStore.save(ctx);
  }

  private async refresh(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await gatewayStore.ensureLoaded(ctx);
    const key = sanitizeKey(this.keyDraft);
    if (key.length >= 16) {
      gatewayStore.key = key;
      await gatewayStore.save(ctx);
    } else if (sanitizeKey(gatewayStore.key).length < 16) {
      this.message = '先保存至少 16 位的中继钥匙';
      this.setupOpen = true;
      return;
    }
    this.busy = true;
    this.message = '';
    try {
      const live = await MachinesClient.list(gatewayStore.apiRoot, gatewayStore.key);
      gatewayStore.upsertDiscovered(live, true);
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
    const platform = host.platform;
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
    this.onOpen();
  }
}
