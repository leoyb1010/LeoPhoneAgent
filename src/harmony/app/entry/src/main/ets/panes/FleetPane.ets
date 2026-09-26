import { common } from '@kit.AbilityKit';
import { promptAction, router } from '@kit.ArkUI';
import { HarnessKind, RemoteTask, displayName, sanitizeKey } from '../net/Protocol';
import { MachinesClient } from '../net/MachinesClient';
import { ChatLaunch, HarnessClient } from '../net/HarnessClient';
import { gatewayStore, SavedHost } from '../store/GatewayStore';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

@Component
export struct FleetPane {
  @Prop wide: boolean = false;
  /** 从首页推进来的一页(手机上):左上角返回。 */
  @Prop showBack: boolean = false;
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
          this.barIcon('house', () => {
            this.onLocal();
          })
        } else if (this.showBack) {
          this.barIcon('chevron_left', () => {
            router.back();
          })
        }
        Text('远程')
          .fontSize(19)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
          .margin({ left: 4 })
          .layoutWeight(1)
        if (this.busy) {
          LoadingProgress()
            .width(20)
            .height(20)
            .color(Tokens.muted)
            .margin({ right: 10 })
        } else {
          this.barIcon('arrow_clockwise', () => {
            if (this.ready) {
              this.refresh();
            }
          })
        }
        if (this.wide) {
          this.barIcon('gearshape', () => {
            this.onSettings();
          })
        }
      }
      .width('100%')
      .height(Tokens.topBar)
      .padding({ left: 6, right: 8 })

      Scroll() {
        Column() {
          if (this.message.length > 0) {
            Text(this.message)
              .fontSize(13)
              .fontColor(this.message === '钥匙已保存' || this.message.startsWith('已加入') ? Tokens.online : Tokens.warn)
              .width('100%')
              .padding({ left: 4, right: 4, bottom: 10 })
          }
          if (this.hosts.length === 0) {
            this.emptyState()
          } else {
            Text('机器')
              .fontSize(13)
              .fontColor(Tokens.secondary)
              .width('100%')
              .padding({ left: 16, bottom: 7 })
            Column() {
              ForEach(this.hosts, (host: SavedHost, index: number) => {
                this.machineCard(host, index > 0)
              }, (host: SavedHost, index: number) => `${index}|${host.name}|${host.displayName}|${host.platform}|${host.online}`)
            }
            .width('100%')
            .backgroundColor(Tokens.card)
            .borderRadius(Tokens.groupRadius)
            .clip(true)
          }
          this.setupCard()
        }
        .width('100%')
        .constraintSize({ maxWidth: Tokens.readable })
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 4, bottom: 32 })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.grouped)
  }

  @Builder
  barIcon(name: string, tap: () => void) {
    Stack() {
      Sym({ name: name, dim: 20, color: Tokens.text })
    }
    .width(40)
    .height(40)
    .onClick(() => {
      tap();
    })
  }

  @Builder
  setupCard() {
    Column() {
      Row() {
        Stack() {
          Sym({ name: 'dot_radiowaves_left_and_right', dim: 16, color: '#FFFFFF' })
        }
        .width(Tokens.settingsIcon)
        .height(Tokens.settingsIcon)
        .backgroundColor('#30B0C7')
        .borderRadius(8)
        Column() {
          Text('中继钥匙与配对')
            .fontSize(16)
            .fontColor(Tokens.text)
          Text(this.setupOpen ? '钥匙至少 16 位，不会写进配对码' : '换钥匙、粘贴配对码加入')
            .fontSize(12.5)
            .fontColor(Tokens.secondary)
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 14 })
        .layoutWeight(1)
        Sym({ name: this.setupOpen ? 'chevron_up' : 'chevron_down', dim: 13, color: Tokens.muted })
      }
      .width('100%')
      .onClick(() => {
        this.setupOpen = !this.setupOpen;
      })
      if (this.setupOpen) {
        TextInput({ placeholder: '中继钥匙', text: this.keyDraft })
          .onChange((value: string) => {
            this.keyDraft = value;
          })
          .type(InputType.Password)
          .height(44)
          .margin({ top: 14 })
          .backgroundColor(Tokens.surface)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(10)
        this.pillButton('保存钥匙', () => {
          this.saveKey();
        })
        TextInput({ placeholder: '粘贴配对码（Mac 或手机上生成的）', text: this.pairDraft })
          .onChange((value: string) => {
            this.pairDraft = value;
          })
          .height(44)
          .margin({ top: 16 })
          .backgroundColor(Tokens.surface)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(10)
        this.pillButton('加入', () => {
          this.joinPair();
        })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .margin({ top: 20 })
    .backgroundColor(Tokens.card)
    .borderRadius(Tokens.groupRadius)
  }

  @Builder
  pillButton(label: string, tap: () => void) {
    Text(label)
      .fontSize(15)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.ready ? Tokens.accent : Tokens.muted)
      .textAlign(TextAlign.Center)
      .width('100%')
      .height(40)
      .backgroundColor(Tokens.accentSoft)
      .borderRadius(20)
      .margin({ top: 8 })
      .onClick(() => {
        if (this.ready) {
          tap();
        }
      })
  }

  @Builder
  emptyState() {
    Column() {
      Sym({ name: 'computer', dim: 40, color: Tokens.muted })
      Text('还没有远程机器')
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .margin({ top: 12 })
      Text('保存中继钥匙后点右上角刷新；也可以粘贴配对码加入一台机器。')
        .fontSize(14)
        .lineHeight(20)
        .fontColor(Tokens.secondary)
        .margin({ top: 6 })
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ top: 40, bottom: 12, left: 12, right: 12 })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  machineCard(host: SavedHost, divider: boolean) {
    Column() {
      if (divider) {
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .margin({ left: 62 })
      }
      Row() {
        Stack() {
          Sym({
            name: host.platform === 'android' || host.platform === 'harmony' ? 'phone' : 'computer',
            dim: 18,
            color: '#FFFFFF'
          })
        }
        .width(34)
        .height(34)
        .backgroundColor(host.online ? '#30B0C7' : Tokens.muted)
        .borderRadius(9)
        Column() {
          Text(host.displayName.length > 0 ? host.displayName : displayName(host.name))
            .fontSize(Tokens.rowTitle)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`${host.platform.length > 0 ? host.platform : 'mac'} · ${host.name}`)
            .fontSize(12.5)
            .fontColor(Tokens.secondary)
            .margin({ top: 2 })
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 14 })
        .layoutWeight(1)
        Row() {
          Column()
            .width(7)
            .height(7)
            .borderRadius(3.5)
            .backgroundColor(host.online ? Tokens.online : Tokens.muted)
          Text(host.online ? '在线' : '离线')
            .fontSize(12.5)
            .fontColor(host.online ? Tokens.online : Tokens.muted)
            .margin({ left: 5 })
        }
        .margin({ right: 6 })
        Sym({ name: 'chevron_right', dim: 13, color: Tokens.muted })
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    }
    .width('100%')
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
    this.message = await gatewayStore.scanPairCode(this.pairDraft, (text: string) => {
      this.message = text;
    });
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
    const client = new HarnessClient(gatewayStore.apiRoot, host.name, gatewayStore.key);
    let harness = 'minis';
    const platform = host.platform;
    if (platform !== 'android' && platform !== 'harmony') {
      let kinds: HarnessKind[] = [];
      try {
        kinds = await client.kinds();
      } catch (err) {
        // 读不到就说出来,不再猜 claude(新版 Mac 自己的 Agent 是 LeoPhoneAgent)。
        this.message = `读不到这台机器上的 Agent:${err instanceof Error ? err.message : err}`;
        return;
      }
      if (kinds.length === 0) {
        this.message = '这台机器没有可用的 Agent';
        return;
      }
      harness = kinds[0].key;
      if (kinds.length > 1) {
        // Mac 1.2 起列出 LeoPhoneAgent、Claude Code、Codex、Grok:让你挑,不再默默用第一个。
        const index = await FleetPane.pick('用哪个 Agent',
          kinds.map((kind: HarnessKind) => kind.name.length > 0 ? kind.name : kind.key));
        if (index < 0) {
          return;
        }
        harness = kinds[index].key;
      }
    }
    // 这台机器上还没结束的任务(含 Mac 桌面上的):挑一个接着看,或者开新任务。列不出来就照旧。
    const key = ChatLaunch.key(host.name, harness);
    let tasks: RemoteTask[] = [];
    try {
      tasks = await client.tasks(harness);
    } catch (_err) {
      tasks = [];
    }
    if (tasks.length > 0) {
      const index = await FleetPane.pick('接着哪个任务',
        ['新任务'].concat(tasks.map((task: RemoteTask) => task.label)));
      if (index < 0) {
        return;
      }
      if (index === 0) {
        ChatLaunch.sessions.delete(key);
      } else {
        ChatLaunch.sessions.set(key, tasks[index - 1].id);
      }
    }
    ChatLaunch.machine = host.name;
    ChatLaunch.harness = harness;
    this.onOpen();
  }

  /** 系统操作菜单,最多 6 项;取消返回 -1。 */
  private static async pick(title: string, labels: string[]): Promise<number> {
    const items: promptAction.Button[] = labels.slice(0, 6).map((text: string) => {
      const item: promptAction.Button = { text: text, color: '#007AFF' };
      return item;
    });
    const buttons: [promptAction.Button, promptAction.Button?, promptAction.Button?, promptAction.Button?,
      promptAction.Button?, promptAction.Button?] = [items[0]];
    for (let i = 1; i < items.length; i++) {
      buttons.push(items[i]);
    }
    try {
      const picked: promptAction.ActionMenuSuccessResponse =
        await promptAction.showActionMenu({ title: title, buttons: buttons });
      return picked.index;
    } catch (_err) {
      return -1;
    }
  }
}
