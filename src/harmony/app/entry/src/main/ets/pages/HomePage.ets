import { destination } from '../navigation/Destinations';
import { LayoutState, resolveLayout } from '../layout/LayoutPolicy';
import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import display from '@ohos.display';
import { inputMethod } from '@kit.IMEKit';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { ReleaseNotesStore } from '../store/ReleaseNotesStore';
import { MachinesClient } from '../net/MachinesClient';
import { gatewayStore } from '../store/GatewayStore';
import { ChatLaunch, HarnessClient } from '../net/HarnessClient';
import { FoldLayout } from '../layout/FoldLayout';
import { FleetPane } from '../panes/FleetPane';
import { ChatPane } from '../panes/ChatPane';
import { SettingsPane } from '../panes/SettingsPane';
import { LocalAgentPane } from '../panes/LocalAgentPane';
import { themeStore } from '../store/ThemeStore';
import { ActionButton } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct HomePage {
  @StorageProp('themeTick') tick: number = 0;
  @State showNotes: boolean = false;
  @State notesBusy: boolean = false;
  @State notesError: string = '';
  @State notesTitle: string = '';
  @State notesLines: string[] = [];
  @State wide: boolean = false;
  @State pathStack: NavPathStack = AppNavigation.stack;
  @StorageProp('navigationTick') navigationTick: number = 0;
  @StorageProp('windowFrameWidth') @Watch('onWindowFrame') windowWidth: number = 0;
  @StorageLink('inspectorVisible') inspectorVisible: boolean = false;
  private layoutState: LayoutState = new LayoutState();
  private widthTimer: number = -1;
  @State tab: number = 0;
  @State chatMachine: string = '';
  @State chatLaunch: number = 0;
  /** 点通知回来要打开某个本机对话:先切到本机这一栏,LocalAgentPane 再打开它。 */
  @StorageProp('requestedSession') @Watch('onOpenSession') openRequest: string = '';
  @StorageProp('pushRemoteTick') @Watch('onPushRequest') pushRequest: number = 0;
  @StorageProp('platformForeground') @Watch('onPushRequest') foreground: boolean = false;
  @State pushError: string = '';
  @StorageProp('windowFrameHeight') @Watch('onWindowFrame') frameHeight: number = 0;
  @StorageProp('keyboardVisible') keyboardVisible: boolean = false;
  private lastWidth: number = 0;
  private lastHeight: number = 0;
  @StorageProp('requestedPage') @Watch('onRequestedPage') requestedPage: string = '';
  private notesReady: boolean = false;
  private pageAlive: boolean = false;
  private pushRouting: boolean = false;
  private consumedPush: number = 0;
  private foldCb: ((status: display.FoldStatus) => void) | null = null;

  aboutToAppear(): void {
    this.pageAlive = true;
    AppNavigation.ready = true;
    const first = ReleaseCatalog.all()[0];
    this.notesTitle = first.title;
    this.notesLines = first.highlights;
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.load(ctx);
    ReleaseNotesStore.shouldShow(ctx).then((show: boolean) => {
      this.showNotes = show;
      this.notesReady = true;
      this.drainNavigation();
    }).catch(() => { this.showNotes = true; this.notesReady = true; });
    this.syncWide(0, 0);
    this.onOpenSession();
    this.foldCb = (_status: display.FoldStatus) => {
      this.syncWide(0, 0);
    };
    try {
      display.on('foldStatusChange', this.foldCb);
    } catch (_err) {
      // non-fold devices
    }
  }

  onOpenSession(): void {
    if (!this.pageAlive || !this.foreground || !this.notesReady || this.showNotes || !this.openRequest) return;
    this.tab = 0;
    AppStorage.setOrCreate('openSession', this.openRequest);
    AppStorage.setOrCreate('requestedSession', '');
  }

  onRequestedPage(): void {
    if (!this.pageAlive || !this.foreground || !this.notesReady || this.showNotes || !this.requestedPage) return;
    const page = this.requestedPage;
    if (!/^pages\/(BrainSpace|Workspace|Terminal|Recordings|Settings|Collections|Sync|Approval|SSHTerminal)Page$/.test(page)) return;
    AppNavigation.pushUrl({ url: page }).then(() => {
      if (this.requestedPage === page) AppStorage.setOrCreate('requestedPage', '');
    }).catch(() => { this.pushError = '页面暂时没有打开，请重试'; });
  }

  private drainNavigation(): void {
    this.onOpenSession();
    this.onRequestedPage();
    this.onPushRequest();
  }

  onPageShow(): void {
    AppStorage.setOrCreate('providerTick', Date.now());
    this.drainNavigation();
  }

  onBackPress(): boolean {
    if (this.keyboardVisible) {
      inputMethod.getController().hideSoftKeyboard().catch(() => {});
      return true;
    }
    if (this.inspectorVisible) { this.inspectorVisible = false; AppStorage.setOrCreate('inspectorManualAt', Date.now()); return true; }
    if (this.pathStack.size() > 0) { AppNavigation.back(); return true; }
    if (this.tab !== 0) { this.tab = 0; return true; }
    const selected = AppStorage.get<string>('homeSessionId') ?? '';
    if (selected) { AppStorage.setOrCreate('homeSessionId', ''); return true; }
    return false;
  }

  onPushRequest(): void {
    this.routePush();
  }

  private async routePush(): Promise<void> {
    const tick = this.pushRequest;
    if (!this.pageAlive || !this.foreground || !this.notesReady || this.showNotes || this.pushRouting || tick <= this.consumedPush) return;
    const machine = AppStorage.get<string>('pushRemoteMachine') ?? '';
    const session = AppStorage.get<string>('pushRemoteSession') ?? '';
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(machine) || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return;
    this.pushRouting = true;
    this.pushError = '';
    try {
      const context = getContext(this) as common.UIAbilityContext;
      await gatewayStore.ensureLoaded(context);
      const root = gatewayStore.apiRoot;
      const key = gatewayStore.key;
      const hosts = await MachinesClient.list(root, key);
      const saved = gatewayStore.hosts.find((host) => host.name === machine);
      if (saved && !saved.enabled) throw new Error('这台远程机器已被停用');
      if (!hosts.some((host) => host.name === machine && host.online)) throw new Error('远程机器暂时离线，稍后可以重试');
      const client = new HarnessClient(root, machine, key);
      const current = await client.session(session);
      const harness = `${current['harness'] ?? ''}`;
      if (!harness || harness.length > 80) throw new Error('远程任务缺少有效执行器');
      if (!this.pageAlive || !this.foreground || this.pushRequest !== tick || root !== gatewayStore.apiRoot || key !== gatewayStore.key) return;
      ChatLaunch.machine = machine;
      ChatLaunch.harness = harness;
      ChatLaunch.sessions.set(ChatLaunch.key(machine, harness), session);
      await AppNavigation.pushUrl({ url: 'pages/RemoteChatPage' });
      this.consumedPush = tick;
    } catch (error) {
      this.pushError = `${error}`;
    } finally {
      this.pushRouting = false;
      if (this.pageAlive && this.pushRequest > tick && this.foreground) this.onPushRequest();
    }
  }

  aboutToDisappear(): void {
    this.pageAlive = false;
    AppNavigation.ready = false;
    if (this.widthTimer >= 0) clearTimeout(this.widthTimer);
    if (this.foldCb) {
      try {
        display.off('foldStatusChange', this.foldCb);
      } catch (_err) {
        // ignore
      }
    }
  }

  build() {
    Navigation(this.pathStack) {
    Column() {
      if (this.pushError) {
        Text(this.pushError).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.warn)).padding(12).width('100%')
      }
      this.wideBody()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.reactive(this.tick, Tokens.bg))
    .onAreaChange((_old: Area, now: Area) => {
      this.syncWide(Number(now.width), Number(now.height));
    })
    .bindSheet($$this.showNotes, this.notesSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true,
      backgroundColor: Tokens.card,
      onDisappear: () => { this.drainNavigation(); }
    })
    }
    .hideTitleBar(true).hideBackButton(true)
    .mode(this.wide && this.navigationTick >= 0 && this.pathStack.size() > 0 ? NavigationMode.Split : NavigationMode.Stack)
    .navBarWidth(this.windowWidth >= 840 ? this.windowWidth - 360 : '50%')
    .navBarWidthRange([280, Math.max(280, this.windowWidth - 280)])
    .minContentWidth(280)
    .navDestination(destination)
    .width('100%').height('100%')
  }

  /** 展开的折叠屏、平板:本机(列表 + 对话)、远程(机器 + 远程对话)、设置,三者之间用各自顶栏的图标切换。 */
  @Builder
  wideBody() {
    if (this.tab === 2) {
      SettingsPane({
        showBack: true,
        onBack: () => {
          this.tab = 0;
        }
      })
    } else if (this.tab === 1) {
      Row() {
        FleetPane({
          wide: true,
          onOpen: () => {
            this.chatMachine = ChatLaunch.machine;
            this.chatLaunch += 1;
          },
          onLocal: () => {
            this.tab = 0;
          },
          onSettings: () => {
            AppNavigation.pushUrl({ url: 'pages/SettingsPage' });
          }
        })
          .width(this.wide ? (this.windowWidth >= 840 ? 208 : '40%') : '100%')
          .visibility(this.wide || !this.chatMachine ? Visibility.Visible : Visibility.None)
        Column()
          .width(Tokens.hairline)
          .height('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.separator))
        ChatPane({ machine: this.chatMachine, launch: this.chatLaunch, showBack: !this.wide,
          onBack: () => { this.chatMachine = ''; } })
          .layoutWeight(1).visibility(this.wide || this.chatMachine ? Visibility.Visible : Visibility.None)
      }
      .width('100%')
      .layoutWeight(1)
    } else {
      LocalAgentPane({
        wide: this.wide && this.pathStack.size() === 0 && this.navigationTick >= 0,
        onRemote: () => {
          if (this.wide) this.tab = 1;
          else AppNavigation.pushUrl({ url: 'pages/FleetPage' });
        },
        onSettings: () => {
          AppNavigation.pushUrl({ url: 'pages/SettingsPage' });
        }
      })
        .layoutWeight(1)
    }
  }

  @Builder
  notesSheet() {
    Column({ space: 14 }) {
      Scroll() {
        Column({ space: 14 }) {
          Text('本次更新').fontSize(12).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).width('100%')
          Text(this.notesTitle).fontSize(24).fontWeight(FontWeight.Bold)
            .fontColor(Tokens.reactive(this.tick, Tokens.text)).width('100%')
          ForEach(this.notesLines, (line: string) => {
            Row({ space: 12 }) {
              Column().width(5).height(5).borderRadius(3).backgroundColor(Tokens.reactive(this.tick, Tokens.accent)).margin({ top: 9 })
              Text(line).fontSize(15).fontColor(Tokens.reactive(this.tick, Tokens.text)).layoutWeight(1)
            }.width('100%').alignItems(VerticalAlign.Top)
          }, (line: string) => line)
        }.width('100%').alignItems(HorizontalAlign.Start).padding({ right: 4, bottom: 8 })
      }
      .width('100%')
      .constraintSize({ maxHeight: Math.max(80, (this.frameHeight || this.lastHeight || 640) - 180) })
      .scrollBar(BarState.Off)
      if (this.notesError) {
        Text(this.notesError).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.danger)).width('100%')
      }
      ActionButton({ label: '知道了', busy: this.notesBusy, onTap: () => {
        this.notesBusy = true;
        this.notesError = '';
        const context = getContext(this) as common.UIAbilityContext;
        ReleaseNotesStore.markSeen(context).then(() => { this.showNotes = false; this.drainNavigation(); })
          .catch(() => { this.notesError = '更新记录暂时没有保存，请重试'; })
          .finally(() => { this.notesBusy = false; });
      } })
    }
    .width('100%').alignItems(HorizontalAlign.Start)
    .padding({ left: 24, right: 24, top: 10, bottom: 28 })
  }


  onWindowFrame(): void {
    this.syncWide(this.lastWidth, this.lastHeight);
  }

  private syncWide(width: number, height: number): void {
    if (width <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    // Keyboard RESIZE changes content height, not the window's structural layout.
    if (this.widthTimer >= 0) clearTimeout(this.widthTimer);
    this.widthTimer = setTimeout(() => {
      this.widthTimer = -1;
      this.layoutState.inspector = this.inspectorVisible;
      this.layoutState.manualAt = AppStorage.get<number>('inspectorManualAt') ?? -1500;
      this.layoutState = resolveLayout(this.layoutState, this.windowWidth || width, Date.now());
      this.wide = this.layoutState.size !== 'sm';
      this.inspectorVisible = this.layoutState.inspector;
    }, 350);
  }
}
