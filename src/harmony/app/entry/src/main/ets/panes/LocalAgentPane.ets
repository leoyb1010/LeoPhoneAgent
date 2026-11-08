import { UndoDeletion, PendingDeletion } from '../store/UndoDeletion';
import { Haptics } from '../theme/Haptics';
import { ChatInspector } from './ChatInspector';
import { AppNavigation } from '../navigation/AppNavigation';
import { IconButton, ActionButton, Skeleton } from '../theme/Controls';
import { MotionPolicy } from '../theme/MotionPolicy';
import { ChatViewState } from '../local/ChatViewState';
import { Voice } from '../local/Voice';
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { FirstMessage, LocalChatLaunch, LocalChatPane } from './LocalChatPane';
import { Attachments } from '../chat/Attachments';
import { Composer } from '../chat/Composer';
import { ChatRuns, PendingImage } from '../local/ChatRun';
import { FastLocalActions } from '../local/FastLocalActions';
import { relativeTime } from '../local/LocalProtocol';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { sessionStore, LocalSession, LocalSessionSummary, SessionGroup } from '../store/SessionStore';
import { providerStore, ProviderLaunch } from '../store/ProviderStore';
import { taskStatus } from '../store/TaskStatus';
import { themeStore } from '../store/ThemeStore';
import { Copy } from '../theme/Copy';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

class HomeAttachment {
  static sending: boolean = false;
  static focusSequence: number = 0;
}

/** 对话头像的颜色:按标题挑一个,同一个对话每次一样。 */

function avatarColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return Tokens.avatarColors[Math.abs(hash) % Tokens.avatarColors.length];
}

/** 一行对话的 key:画面上用到的都在里面(鸿蒙 ForEach key 不变就不重画,改了标题也还显示旧的)。 */
function sessionKey(row: LocalSessionSummary): string {
  return `${row.id}|${row.title}|${row.updatedAt}|${row.pinned}|${row.lastMessage.substring(0, 100)}|${ChatViewState.draftText(row.id).substring(0, 80)}`;
}

/**
 * 首页:本机对话列表。和 iOS / 安卓一样,顶上是设置、搜索、远程;按置顶 / 今天 / 昨天…分组;
 * 手机上最下面是一个输入框,说一句就开新对话。展开的折叠屏、平板上左边是列表、右边是对话。
 */
@Component
export struct LocalAgentPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @StorageProp('taskTick') @Watch('onTaskTick') taskTick: number = 0;
  @StorageProp('approvalTick') approvalTick: number = 0;
  /** 点通知回来要打开的对话(EntryAbility 放进来,用完清空)。 */
  @StorageProp('openSession') @Watch('onOpenSession') openRequest: string = '';
  /** 正在跑(或等你确认)的对话:列表里标出来。 */
  @StorageProp('chatViewTick') @Watch('onHomeVoice') voiceTick: number = 0;
  @State activeIds: string[] = [];
  @State viewportWidth: number = 0;
  @State viewportHeight: number = 720;
  @State homeSending: boolean = false;
  @State homeFocusTicket: number = 0;
  @StorageProp('motionReduced') reduced: boolean = false;
  @State listening: boolean = false;
  private voiceVersion: number = 0;
  @Prop wide: boolean = false;
  @StorageLink('inspectorVisible') inspectorVisible: boolean = false;
  @StorageProp('windowFrameWidth') windowWidth: number = 0;
  private listScroller: Scroller = new Scroller();
  onRemote: () => void = () => {};
  onSettings: () => void = () => {};
  @StorageLink('homeSessionId') sessionId: string = '';
  @State groups: SessionGroup[] = [];
  @State deletions: PendingDeletion[] = [];
  @StorageProp('deletionTick') @Watch('onDeletion') deletionTick: number = 0;
  @State query: string = '';
  @State importDraft: string = '';
  @State message: string = '';
  @State ready: boolean = false;
  @State configured: boolean = false;
  @State modelLine: string = '';
  @State importOpen: boolean = false;
  @State searchOpen: boolean = false;
  @State menuOpen: boolean = false;
  @State menuId: string = '';
  @State menuTitle: string = '';
  @State menuPinned: boolean = false;
  @StorageLink('homeDraft') @Watch('homeDraftChanged') draft: string = '';
  @StorageProp('draftError') @Watch('onHomeDraftError') draftError: string = '';
  @StorageProp('draftTick') @Watch('onHomeDraftTick') draftTick: number = 0;
  private restoringHome: boolean = false;
  @StorageLink('homeFiles') @Watch('homeDraftChanged') homeFiles: string[] = [];
  @StorageLink('homeImagePath') @Watch('homeDraftChanged') homeImagePath: string = '';
  @State homeImagePaths: string[] = [];
  private get homeImages(): PendingImage[] { const images = ChatViewState.get('home').images; return Array.isArray(images) ? images : []; }
  private set homeImages(value: PendingImage[]) {
    if (!Array.isArray(value)) return;
    const row = ChatViewState.get('home'); row.images = value; row.image = value[0] ?? null;
  }
  private get homeImage(): PendingImage | null { return ChatViewState.get('home').image ?? null; }
  private set homeImage(value: PendingImage | null) { if (value !== undefined) ChatViewState.get('home').image = value; }
  private launched: boolean = false;

  aboutToAppear(): void {
    ChatViewState.initialize(getContext(this) as common.UIAbilityContext);
    this.deletions = UndoDeletion.entries();
    const saved = ChatViewState.get('home');
    this.restoringHome = true;
    this.draft = saved.draft; this.homeFiles = saved.files.slice();
    this.homeImages = Array.isArray(saved.images) && saved.images.length ? saved.images.slice() : (saved.image ? [saved.image] : []);
    this.homeImagePaths = this.homeImages.map((image: PendingImage) => image.path); this.homeImagePath = this.homeImage?.path ?? '';
    this.restoringHome = false;
    this.activeIds = ChatRuns.activeIds();
    const voice = ChatViewState.get('home'); this.listening = voice.listening;
    this.homeSending = HomeAttachment.sending; this.onHomeVoice();
    this.reload();
  }

  aboutToDisappear(): void { this.homeDraftChanged(); ChatViewState.flush(); }
  homeDraftChanged(): void { if (!this.restoringHome) this.saveHomeDraft(); }
  onHomeDraftError(): void { if (this.draftError) this.message = this.draftError; }
  onHomeDraftTick(): void { this.groups = this.visibleGroups(this.query); }
  private saveHomeDraft(): void {
    const row = ChatViewState.get('home');
    // Native view teardown may unbind component properties. Keep the conversation-owned snapshot in that case.
    if (typeof this.draft === 'string') row.draft = this.draft;
    if (Array.isArray(this.homeFiles)) row.files = this.homeFiles.slice();
    ChatViewState.persistSoon();
  }

  onProviderTick(): void {
    this.reload();
  }

  onTaskTick(): void {
    this.activeIds = ChatRuns.activeIds();
    this.groups = this.visibleGroups(this.query);
  }

  private visibleGroups(query: string): SessionGroup[] {
    return sessionStore.grouped(query).map((group: SessionGroup) => {
      const visible = new SessionGroup(); visible.key = group.key; visible.title = group.title;
      visible.rows = group.rows.filter((row: LocalSessionSummary) => !UndoDeletion.hidden(row.id)); return visible;
    }).filter((group: SessionGroup) => group.rows.length > 0);
  }
  onDeletion(): void {
    this.deletions = UndoDeletion.entries(); this.groups = this.visibleGroups(this.query);
    if (UndoDeletion.error) this.message = UndoDeletion.error;
    if (this.sessionId && !sessionStore.summaries.some((row: LocalSessionSummary) => row.id === this.sessionId)) this.sessionId = '';
  }
  onOpenSession(): void {
    this.takeOpenRequest();
  }

  private takeOpenRequest(): boolean {
    const id = this.openRequest;
    if (id.length === 0 || !this.ready) {
      return false;
    }
    AppStorage.setOrCreate('openSession', '');
    this.openSession(id);
    return true;
  }

  build() {
    if (!this.ready) {
      this.loadingSurface()
    } else if (!this.configured) {
      this.connectionSurface()
    } else {
      Row() {
        Column() { this.listColumn() }
          .width(this.wide ? this.listWidth() : '100%').height('100%')
          .visibility(this.wide || !this.sessionId ? Visibility.Visible : Visibility.None)
        if (this.sessionId.length > 0) {
          LocalChatPane({ sessionId: this.sessionId, compact: this.wide,
            onBack: () => { this.sessionId = ''; }, onNew: () => this.createSession() }).layoutWeight(1)
        } else if (this.wide) {
          Column() {
            Column() { this.pickHint() }.layoutWeight(1).width('100%')
            this.homeComposer()
          }.layoutWeight(1).height('100%')
        }
        if (this.wide && this.windowWidth >= 840 && this.inspectorVisible) {
          ChatInspector({ sessionId: this.sessionId, onClose: () => this.toggleInspector() }).width(260)
        }
      }.width('100%').height('100%')
        .onAreaChange((_old: Area, area: Area) => {
          const width = Number.parseFloat(`${area.width}`); const height = Number.parseFloat(`${area.height}`);
          if (width > 0) this.viewportWidth = width; if (height > 0) this.viewportHeight = height;
        })
    }
  }

  private toggleInspector(): void {
    this.inspectorVisible = !this.inspectorVisible;
    AppStorage.setOrCreate('inspectorManualAt', Date.now());
  }

  @Builder
  homeComposer() {
        Column() {
          Composer({
            draft: $draft,
            inputId: 'homeComposerInput',
            focusRequest: this.homeFocusTicket,
            onFocusApplied: (ticket: number) => { if (this.homeFocusTicket === ticket) this.homeFocusTicket = 0; },
            ready: this.ready && !this.homeSending,
            compact: this.viewportHeight < 460,
            listening: this.listening,
            onMic: () => this.toggleHomeVoice(),
            placeholder: '问 Leo，或直接说要做的事',
            modelLabel: this.modelLine,
            showApproval: true,
            fullAuto: SensitiveToolGate.fullAuto && this.approvalTick >= 0,
            approvalLabel: SensitiveToolGate.modeTitle(),
            files: this.homeFiles,
            imagePath: this.homeImagePath,
            imagePaths: this.homeImagePaths,
            returnSend: themeStore.returnSend,
            onSend: () => {
              this.sendFromHome();
            },
            onPickImage: () => {
              this.pickHomeImage();
            },
            onPickFiles: () => {
              this.pickHomeFiles();
            },
            onSlash: () => {
              this.draft = '/';
            },
            onModel: () => {
              this.openModelPick();
            },
            onApproval: () => {
              AppNavigation.pushUrl({ url: 'pages/ApprovalPage' });
            },
            onRemoveFile: (index: number) => {
              this.homeFiles = this.homeFiles.filter((_name: string, i: number) => i !== index);
            },
            onRemoveImage: (index: number) => {
              this.homeImages = this.homeImages.filter((_image: PendingImage, i: number) => i !== index); this.homeImage = this.homeImages[0] ?? null;
              this.homeImagePath = this.homeImage?.path ?? ''; this.homeImagePaths = this.homeImages.map((image: PendingImage) => image.path); this.homeDraftChanged();
            }
          })
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 4, bottom: 10 })
        .constraintSize({ maxWidth: Tokens.readable + 24 })
  }

  @Builder
  listColumn() {
    Column() {
      this.topBar()
      if (this.searchOpen) {
        this.searchBar()
      }
      if (this.message.length > 0) {
        Text(this.message)
          .fontSize(Tokens.time)
          .fontColor(Tokens.warn)
          .width('100%')
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 6 })
      }
      ForEach(this.deletions, (entry: PendingDeletion) => {
        ActionButton({ label: '已移除「' + entry.title + '」 · 撤销', variant: 'secondary',
          onTap: () => { if (!UndoDeletion.undo(entry.id)) this.message = '撤销时间已过'; } })
      }, (entry: PendingDeletion) => `${entry.id}|${entry.title}|${entry.expires}`)
      List({ scroller: this.listScroller }) {
        ListItem() {
          Column() {
            if (!this.configured && this.ready) this.onboarding()
            else this.statusChips()
            if (this.groups.length === 0 && this.ready && this.configured) this.emptyList()
          }.width('100%')
        }
        ForEach(this.groups, (group: SessionGroup) => {
          ListItemGroup({ header: this.groupHeader(group) }) {
            ForEach(group.rows, (row: LocalSessionSummary) => {
              ListItem() { this.sessionRow(row) }
                .swipeAction({ end: this.sessionSwipe(row) })
            }, (row: LocalSessionSummary) => sessionKey(row))
          }
        }, (group: SessionGroup) => `${group.key}|${group.rows.map((row: LocalSessionSummary) => sessionKey(row)).join(',')}`)
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
      .edgeEffect(EdgeEffect.Spring)
      .onScrollStop(() => { ChatViewState.get('home').offset = this.listScroller.currentOffset().yOffset; })
      .onAppear(() => { this.listScroller.scrollTo({ xOffset: 0, yOffset: ChatViewState.get('home').offset }); })
    .bindSheet($$this.menuOpen, this.menuSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true
    })
      if (!this.wide && this.configured) this.homeComposer()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .onAreaChange((_old: Area, area: Area) => {
      if (this.wide) return;
      const width = Number.parseFloat(`${area.width}`); const height = Number.parseFloat(`${area.height}`);
      if (width > 0) this.viewportWidth = width; if (height > 0) this.viewportHeight = height;
    })
    .bindSheet($$this.importOpen, this.importSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true,
      title: { title: '导入对话' }
    })

  }

  @Builder
  topBar() {
    Row() {
      // 分栏时这一列窄,设置收进 ··· 菜单,给标题留地方
      if (!this.wide) {
        this.barIcon('gearshape', () => {
          this.onSettings();
        })
      }
      Text(this.wide ? '对话' : 'LeoBot')
        .fontSize(this.wide ? 20 : 19)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ left: this.wide ? 10 : 4 })
        .layoutWeight(1)
      if (this.wide && this.windowWidth >= 840) {
        IconButton({ icon: 'rectangle_stack', label: this.inspectorVisible ? '关闭右栏' : '打开右栏', selected: this.inspectorVisible, onTap: () => this.toggleInspector() })
      }
      if (this.configured) {
        this.barIcon('magnifyingglass', () => {
          this.searchOpen = !this.searchOpen;
          if (!this.searchOpen) {
            this.query = '';
            this.groups = this.visibleGroups('');
          }
        })
      }
      if (!this.wide) {
        this.barIcon('bookshelf', () => AppNavigation.pushUrl({ url: 'pages/BrainSpacePage' }))
        this.barIcon('computer', () => this.onRemote())
      }
      if (this.wide && this.configured) {
        this.barIcon('square_and_pencil', () => {
          this.createSession();
        })
      }
      Stack() {
        Sym({ name: 'ellipsis_circle', dim: 21, color: Tokens.text })
      }
      .width(44)
      .height(44)
      .accessibilityText('更多操作')
      .bindMenu(this.wide ? [
        { value: '第二大脑', action: () => { AppNavigation.pushUrl({ url: 'pages/BrainSpacePage' }); } },
        { value: '远程机器', action: () => this.onRemote() },
        {
          value: '设置',
          action: () => {
            this.onSettings();
          }
        },
        {
          value: '导入对话',
          action: () => {
            this.importOpen = true;
          }
        }
      ] : [
        {
          value: '新对话',
          action: () => {
            this.createSession();
          }
        },
        {
          value: '导入对话',
          action: () => {
            this.importOpen = true;
          }
        }
      ])
    }
    .width('100%')
    .height(Tokens.topBar)
    .padding({ left: 6, right: 8 })
  }

  @Builder
  barIcon(name: string, tap: () => void) {
    IconButton({ icon: name, label: name === 'gearshape' ? '设置' : (name === 'magnifyingglass' ? '搜索对话' : (name === 'bookshelf' ? '第二大脑' : (name === 'computer' ? '远程机器' : '新对话'))), onTap: tap })
  }

  @Builder
  searchBar() {
    Row() {
      Row() {
        Sym({ name: 'magnifyingglass', dim: 15, color: Tokens.muted })
        TextInput({ placeholder: Copy.searchPlaceholder, text: this.query })
          .onChange((value: string) => {
            this.query = value;
            this.groups = this.visibleGroups(this.query);
          })
          .layoutWeight(1)
          .height(44)
          .fontSize(15)
          .backgroundColor(Tokens.transparent)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .padding({ left: 6 })
      }
      .layoutWeight(1)
      .height(44)
      .padding({ left: 10, right: 6 })
      .backgroundColor(Tokens.surface)
      .borderRadius(19)
      ActionButton({ label: '取消', variant: 'quiet', fullWidth: false, onTap: () => {
        this.query = ''; this.searchOpen = false; this.groups = this.visibleGroups('');
      } })
    }
    .width('100%')
    .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
  }

  /** 进行中、等你批准、手电筒:一排小胶囊(安卓首页的主动卡、iOS 的「N 个会话等你处理」)。 */
  @Builder
  statusChips() {
    if (taskStatus.cardsEnabled && this.taskTick >= 0) {
      Scroll() {
        Row() {
          if (this.activeIds.length > 0) {
            this.chip('dot', `进行中 · ${this.activeIds.length}`, Tokens.accent, () => {
              this.openSession(this.activeIds[0]);
            })
          }
          if (taskStatus.pendingWrite) {
            this.chip('hand', '等你批准', Tokens.warn, () => {
              const id = this.lastSessionId();
              if (id.length > 0) {
                this.openSession(id);
              }
            })
          }
          this.chip('flashlight_on_fill', taskStatus.torchOn ? Copy.cardTorchOff : Copy.cardTorchOn,
            taskStatus.torchOn ? Tokens.warn : Tokens.secondary, () => {
              const ctx = getContext(this) as common.UIAbilityContext;
              FastLocalActions.setTorch(ctx, !taskStatus.torchOn).catch(() => {
                // 开不了就算了
              });
            })
        }
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .align(Alignment.Start)
      .margin({ top: 2, bottom: 6 })
    }
  }

  @Builder
  chip(icon: string, label: string, color: string, tap: () => void) {
    Row() {
      if (icon === 'dot') {
        Column()
          .width(7)
          .height(7)
          .borderRadius(3.5)
          .backgroundColor(color)
      } else {
        Sym({ name: icon, dim: 13, color: color })
      }
      Text(label)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor(icon === 'dot' ? color : Tokens.text)
        .margin({ left: 6 })
    }
    .height(44)
    .padding({ left: 12, right: 12 })
    .backgroundColor(Tokens.surface)
    .borderRadius(16)
    .margin({ right: 8 })
    .onClick(() => {
      tap();
    })
  }

  @Builder
  groupHeader(group: SessionGroup) {
    Text(`${group.title} · ${group.rows.length}`).fontSize(13).fontColor(Tokens.secondary)
      .width('100%').padding({ left: Tokens.pagePad + 4, right: Tokens.pagePad, top: 14, bottom: 8 })
  }
  @Builder
  sessionSwipe(row: LocalSessionSummary) {
    Row({ space: 8 }) {
      ActionButton({ label: row.pinned ? '取消置顶' : '置顶', fullWidth: false, variant: 'secondary', onTap: () => this.pinSession(row.id) })
      ActionButton({ label: '删除', fullWidth: false, variant: 'danger', isEnabled: !ChatRuns.isActive(row.id), onTap: () => this.removeSession(row.id) })
    }.padding(8)
  }

  @Builder
  sessionRow(row: LocalSessionSummary) {
    Row() {
      Stack() {
        Column()
          .width(Tokens.iconCircle)
          .height(Tokens.iconCircle)
          .borderRadius(Tokens.iconCircle / 2)
          .backgroundColor(avatarColor(row.title))
          .opacity(0.16)
        Text(row.title.length > 0 ? row.title.substring(0, 1) : '新')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(avatarColor(row.title))
        if (this.activeIds.indexOf(row.id) >= 0) {
          LoadingProgress()
            .width(Tokens.iconCircle + 6)
            .height(Tokens.iconCircle + 6)
            .color(Tokens.accent)
            .enableLoading(!this.reduced)
        }
      }
      .width(Tokens.iconCircle + 6)
      .height(Tokens.iconCircle + 6)
      Column() {
        Text(row.title)
          .fontSize(Tokens.rowTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(ChatViewState.draftText(row.id) ? '草稿 · ' + ChatViewState.draftText(row.id) : (row.lastMessage.length > 0 ? row.lastMessage : '暂无消息'))
          .fontSize(Tokens.rowSub)
          .fontColor(Tokens.secondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 10 })
      .layoutWeight(1)
      Column() {
        Text(this.activeIds.indexOf(row.id) >= 0 ? '进行中' : relativeTime(row.updatedAt))
          .fontSize(Tokens.time)
          .fontColor(this.activeIds.indexOf(row.id) >= 0 ? Tokens.accent : Tokens.muted)
        if (row.pinned) {
          Sym({ name: 'pin_fill', dim: 11, color: Tokens.muted })
            .margin({ top: 6 })
        }
      }
      .alignItems(HorizontalAlign.End)
      .margin({ left: 8 })
    }
    .width(this.wide ? 'calc(100% - 16vp)' : '100%')
    .height(76)
    .padding({ left: this.wide ? 6 : 10, right: this.wide ? 10 : 16 })
    .margin({ left: this.wide ? 8 : 0, right: this.wide ? 8 : 0 })
    .backgroundColor(this.wide && this.sessionId === row.id ? Tokens.surface : Tokens.transparent)
    .borderRadius(this.wide ? 16 : 0)
    .accessibilityGroup(true)
    .accessibilityText(row.title + '，' + (this.activeIds.indexOf(row.id) >= 0 ? '任务进行中' : relativeTime(row.updatedAt)))
    .focusable(true)
    .gesture(
      LongPressGesture({ repeat: false })
        .onAction(() => {
          this.menuId = row.id;
          this.menuTitle = row.title;
          this.menuPinned = row.pinned;
          this.menuOpen = true;
        })
    )
    .onClick(() => {
      this.openSession(row.id);
    })
  }

  @Builder
  emptyList() {
    Column() {
      Image(Tokens.dark ? $r('app.media.leobot_mark_dark') : $r('app.media.leobot_mark')).width(56).height(56).objectFit(ImageFit.Contain)
      Text('有什么要我做的？')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .margin({ top: 14 })
      Text('在下面说一句就开始，也可以试试：')
        .fontSize(14)
        .fontColor(Tokens.secondary)
        .margin({ top: 6, bottom: 16 })
      Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Center }) {
        this.suggestion('整理今天要做的事')
        this.suggestion('查一下明天的天气')
        this.suggestion('搜一搜最新的新闻')
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 64 })
  }

  @Builder
  suggestion(text: string) {
    Text(text)
      .fontSize(14)
      .fontColor(Tokens.text)
      .padding({ left: 14, right: 14, top: 8, bottom: 8 })
      .backgroundColor(Tokens.surface)
      .borderRadius(18)
      .margin(4)
      .onClick(() => {
        this.draft = text;
      })
  }

  @Builder
  pickHint() {
    Column({ space: 14 }) {
      Image(Tokens.dark ? $r('app.media.leobot_mark_dark') : $r('app.media.leobot_mark')).width(56).height(56).objectFit(ImageFit.Contain)
      Text('今天想做什么').fontSize(25).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
      Text('选择一个对话，或交代一件新的事。').fontSize(15).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
      ActionButton({ label: '新对话', icon: 'square_and_pencil', fullWidth: false, onTap: () => this.createSession() }).margin({ top: 8 })
    }.layoutWeight(1).height('100%').padding(28).justifyContent(FlexAlign.Center).backgroundColor(Tokens.bg)
  }

  @Builder
  setupChrome() {
    Row() {
      IconButton({ icon: 'gearshape', label: '设置', onTap: () => this.onSettings() })
      Blank()
      IconButton({ icon: 'bookshelf', label: '第二大脑', onTap: () => AppNavigation.pushUrl({ url: 'pages/BrainSpacePage' }) })
      IconButton({ icon: 'computer', label: '远程机器', onTap: () => this.onRemote() })
    }.height(56).width('100%').padding({ left: 10, right: 10 })
  }

  @Builder
  loadingSurface() {
    Column() {
      this.setupChrome()
      Column({ space: 14 }) {
        if (this.message) {
          Text('本机资料暂时无法读取').fontSize(22).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
          Text(this.message).fontSize(14).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
          ActionButton({ label: '重新读取', fullWidth: false, onTap: () => { this.message = ''; this.reload(); } })
        } else {
          Skeleton({ label: '正在读取对话' })
          Text('正在读取本机对话').fontSize(15).fontColor(Tokens.secondary)
        }
      }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center).padding(24)
    }.width('100%').height('100%').backgroundColor(Tokens.bg)
  }

  @Builder
  connectionSurface() {
    Column() {
      this.setupChrome()
      Scroll() {
        this.onboarding()
      }.layoutWeight(1).width('100%').align(Alignment.Center).scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor(Tokens.bg)
  }

  @Builder
  onboarding() {
    Column({ space: 16 }) {
      Image(Tokens.dark ? $r('app.media.leobot_mark_dark') : $r('app.media.leobot_mark'))
        .width(80).height(80).objectFit(ImageFit.Contain).accessibilityText('LeoBot')
      Text('从一件事开始').fontSize(30).fontWeight(FontWeight.Bold).fontColor(Tokens.text).textAlign(TextAlign.Center)
      Text('连接一个 AI 服务商。\n让 LeoBot 帮你整理资料、完成任务。')
        .fontSize(16).lineHeight(25).fontColor(Tokens.secondary).textAlign(TextAlign.Center).constraintSize({ maxWidth: 420 })
      ActionButton({ label: '连接 AI 服务商', icon: 'plus', onTap: () => AppNavigation.pushUrl({ url: 'pages/ProviderListPage' }) })
        .width('100%').constraintSize({ maxWidth: 380 }).margin({ top: 12 })
      Text('服务商密钥由设备钥匙串保管。').fontSize(13).fontColor(Tokens.muted).textAlign(TextAlign.Center)
      if (this.draft || this.homeFiles.length > 0 || this.homeImagePath) {
        Column({ space: 6 }) {
          Text('本机草稿').fontSize(13).fontWeight(FontWeight.Medium).fontColor(Tokens.accent).width('100%')
          Text(this.draft || '已添加附件').fontSize(14).lineHeight(21).fontColor(Tokens.secondary).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        }.width('100%').padding(16).backgroundColor(Tokens.surface).borderRadius(16).margin({ top: 10 })
      }
      if (this.message) Text(this.message).fontSize(14).fontColor(Tokens.warn).width('100%')
    }.width('100%').constraintSize({ maxWidth: 552 }).padding({ left: 28, right: 28, top: 36, bottom: 64 })
      .alignItems(HorizontalAlign.Center)
  }

  @Builder
  importSheet() {
    Column() {
      Text('只接受带 messages 的 JSON(「导出对话」复制出来的那种)。')
        .fontSize(13)
        .fontColor(Tokens.secondary)
        .width('100%')
        .margin({ bottom: 10 })
      TextArea({ placeholder: '{"messages":[{"role":"user","content":"..."}]}', text: this.importDraft })
        .onChange((value: string) => {
          this.importDraft = value;
        })
        .height(120)
        .backgroundColor(Tokens.surface)
        .fontColor(Tokens.text)
        .placeholderColor(Tokens.muted)
        .borderRadius(12)
      Text('导入')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.sendGlyph)
        .textAlign(TextAlign.Center)
        .width('100%')
        .height(46)
        .backgroundColor(Tokens.accent)
        .borderRadius(23)
        .margin({ top: 12 })
        .onClick(() => {
          this.importSession();
        })
    }
    .width('100%')
    .padding({ left: 20, right: 20, bottom: 24 })
  }

  @Builder
  menuSheet() {
    Column() {
      Text(this.menuTitle)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.secondary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .padding({ bottom: 8 })
      this.menuRow(this.menuPinned ? '取消置顶' : '置顶', 'pin_fill', Tokens.text, () => {
        this.pinSession(this.menuId);
      })
      this.menuRow('复制一份', 'doc_filled_on_doc', Tokens.text, () => {
        this.duplicateSession(this.menuId);
      })
      this.menuRow('导出对话', 'square_and_arrow_down', Tokens.text, () => {
        this.exportSession(this.menuId);
      })
      this.menuRow('归档', 'rectangle_stack', Tokens.text, () => {
        this.archiveSession(this.menuId);
      })
      this.menuRow('删除', 'trash', Tokens.danger, () => {
        this.removeSession(this.menuId);
      })
    }
    .width('100%')
    .padding({ left: 20, right: 20, top: 4, bottom: 24 })
  }

  @Builder
  menuRow(label: string, icon: string, color: string, tap: () => void) {
    Row() {
      Sym({ name: icon, dim: 18, color: color })
      Text(label)
        .fontSize(16)
        .fontColor(color)
        .margin({ left: 14 })
    }
    .width('100%')
    .height(50)
    .onClick(() => {
      this.menuOpen = false;
      tap();
    })
  }

  /** 按当前窗口分配侧栏，三折叠全展开保持独立可读正文。 */
  private listWidth(): string | number {
    if (this.inspectorVisible && this.windowWidth >= 840) return 280;
    if (this.viewportWidth <= 0) return '32%';
    return this.viewportWidth >= Tokens.largeBreak ? Math.min(340, Math.max(280, this.viewportWidth * 0.27)) : Math.max(208, this.viewportWidth * 0.32);
  }

  private async sendFromHome(): Promise<void> {
    if (HomeAttachment.sending) return;
    HomeAttachment.sending = true; this.homeSending = true;
    try { await this.submitFromHome(); } finally { HomeAttachment.sending = false; this.homeSending = false; }
  }

  private async submitFromHome(): Promise<void> {
    const text = this.draft.trim();
    if (!text && !this.homeImage && this.homeFiles.length === 0) {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    const voice = ChatViewState.get('home');
    if (voice.stopListen) { voice.stopListen(); voice.stopListen = null; voice.listening = false; }
    try {
      const session = await sessionStore.create(ctx);
      const first = new FirstMessage();
      first.sessionId = session.id;
      first.text = text;
      first.files = this.homeFiles;
      first.image = this.homeImage; first.images = this.homeImages.slice();
      const draft = ChatViewState.get(session.id); draft.draft = this.draft; draft.files = this.homeFiles.slice(); draft.image = this.homeImage; draft.images = this.homeImages.slice();
      first.submissionId = ChatViewState.beginSubmission(session.id);
      LocalChatLaunch.first = first;
      Haptics.light();
      this.draft = '';
      voice.voiceGeneration += 1; voice.draft = ''; voice.voiceVersion += 1; this.voiceVersion = voice.voiceVersion;
      ChatViewState.changed();
      this.homeFiles = [];
      this.homeImage = null; this.homeImages = []; this.homeImagePaths = [];
      this.homeImagePath = '';
      this.groups = this.visibleGroups(this.query);
      this.openSession(session.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  onHomeVoice(): void {
    const voice = ChatViewState.get('home');
    if (voice.voiceVersion > this.voiceVersion) { this.draft = voice.draft; this.voiceVersion = voice.voiceVersion; }
    this.listening = voice.listening; if (voice.voiceError) this.message = voice.voiceError;
  }

  private async toggleHomeVoice(): Promise<void> {
    const voice = ChatViewState.get('home');
    if (voice.stopListen) { voice.stopListen(); voice.stopListen = null; voice.listening = false; ChatViewState.changed(); return; }
    if (voice.listening) { voice.voiceGeneration += 1; voice.listening = false; ChatViewState.changed(); return; }
    const generation = ++voice.voiceGeneration;
    voice.listening = true; voice.voiceError = ''; ChatViewState.changed();
    try {
      const stop = await Voice.listen(getContext(this) as common.UIAbilityContext, (text: string, last: boolean) => {
        if (voice.voiceGeneration !== generation) return;
        voice.draft = text; voice.voiceVersion += 1;
        if (last) { voice.listening = false; voice.stopListen = null; }
        ChatViewState.changed();
      }, (message: string) => { if (voice.voiceGeneration !== generation) return; voice.voiceError = message; voice.listening = false; voice.stopListen = null; ChatViewState.changed(); }, () => voice.voiceGeneration === generation);
      if (voice.listening) voice.stopListen = stop; else stop();
    } catch (error) { if (voice.voiceGeneration !== generation) return; voice.voiceError = `${error}`; voice.listening = false; voice.stopListen = null; ChatViewState.changed(); }
  }

  private async pickHomeImage(): Promise<void> {
    try {
      const images = await Attachments.pickImages(getContext(this) as common.UIAbilityContext, 16 - this.homeImages.length);
      if (!images.length) return;
      this.homeImages = this.homeImages.concat(images); this.homeImage = this.homeImages[0] ?? null;
      this.homeImagePath = this.homeImage?.path ?? ''; this.homeImagePaths = this.homeImages.map((image: PendingImage) => image.path); this.homeDraftChanged();
    } catch (err) {
      this.message = err instanceof Error ? err.message : `${err}`;
    }
  }

  private async pickHomeFiles(): Promise<void> {
    try {
      const picked = await Attachments.pickFiles(getContext(this) as common.UIAbilityContext);
      this.homeFiles = this.homeFiles.concat(picked.names);
      if (picked.skipped > 0) {
        this.message = `有 ${picked.skipped} 个文件超过 20MB,没带上`;
      }
    } catch (err) {
      this.message = err instanceof Error ? err.message : `${err}`;
    }
  }

  private applyLaunch(): void {
    if (this.takeOpenRequest()) {
      this.launched = true;
      return;
    }
    if (this.launched || !this.configured) {
      return;
    }
    this.launched = true;
    if (themeStore.launch === 'new') {
      this.createSession();
      return;
    }
    // 「自动」和 iOS 一样:一天内打开就回到上次的对话,隔得久了停在首页(原来选了也不生效)。
    if (themeStore.launch === 'last' || themeStore.launch === 'auto') {
      const id = this.lastSessionId(themeStore.launch === 'auto' ? 24 * 3600 * 1000 : 0);
      if (id.length > 0) {
        this.openSession(id);
      }
    }
  }

  /** 最近更新的对话;withinMs > 0 时只认这段时间内动过的。 */
  private lastSessionId(withinMs: number = 0): string {
    const rows = sessionStore.listActive();
    let best = '';
    let stamp = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].updatedAt > stamp) {
        stamp = rows[i].updatedAt;
        best = rows[i].id;
      }
    }
    if (withinMs > 0 && Date.now() - stamp > withinMs) {
      return '';
    }
    return best;
  }

  private hasSessions(): boolean {
    return this.groups.length > 0;
  }

  private openModelPick(): void {
    const row = providerStore.active();
    if (row) {
      ProviderLaunch.id = row.id;
      AppNavigation.pushUrl({ url: 'pages/ProviderDetailPage' });
      return;
    }
    AppNavigation.pushUrl({ url: 'pages/ProviderListPage' });
  }

  private reload(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    Promise.all([
      providerStore.ensureLoaded(ctx),
      sessionStore.ensureLoaded(ctx),
      SensitiveToolGate.load(ctx)
    ]).then(() => {
      this.configured = providerStore.configured();
      const active = providerStore.active();
      this.modelLine = active ? active.model : '';
      this.groups = this.visibleGroups(this.query);
      this.ready = true;
      if (SensitiveToolGate.lastError) this.message = SensitiveToolGate.lastError;
      if (sessionStore.jsonLoadFailed) {
        this.message = '对话档案读坏了，先别保存，避免覆盖';
      }
      this.applyLaunch();
    }).catch((err: Error) => {
      this.message = `${err}`;
    });
  }

  private async createSession(): Promise<void> {
    this.sessionId = ''; LocalChatLaunch.sessionId = '';
    this.homeFocusTicket = ++HomeAttachment.focusSequence;
  }

  private async importSession(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const session: LocalSession = await sessionStore.importArchive(ctx, this.importDraft);
      this.importDraft = '';
      this.importOpen = false;
      this.groups = this.visibleGroups(this.query);
      this.openSession(session.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async pinSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await sessionStore.togglePin(ctx, id);
      this.groups = this.visibleGroups(this.query);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async archiveSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await sessionStore.archive(ctx, id);
      if (this.sessionId === id) {
        this.sessionId = '';
      }
      this.groups = this.visibleGroups(this.query);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async removeSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const title = sessionStore.summaries.find((row: LocalSessionSummary) => row.id === id)?.title ?? '这条对话';
    try {
      const picked = await promptAction.showDialog({
        title: '删除对话?',
        message: `「${title}」将在 5 秒后从这台设备删除，期间可在列表撤销。正在运行或审批的会话不能删除。`,
        buttons: [
          { text: '删除', color: Tokens.danger },
          { text: '取消', color: Tokens.secondary }
        ]
      });
      if (picked.index !== 0) {
        return;
      }
    } catch (_err) {
      return;
    }
    if (ChatRuns.isActive(id)) { this.message = '请先停止任务或处理审批，再删除对话'; return; }
    UndoDeletion.stage(id, title, async () => {
      if (ChatRuns.isActive(id)) throw new Error('会话已开始运行，未删除');
      await sessionStore.remove(ctx, id);
      ChatRuns.invalidateIdle(id);
    });
    this.onDeletion();
  }

  /** 复制成档案放进剪贴板;另一台设备「导入对话」粘贴就能接着聊。 */
  private async exportSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const archive = await sessionStore.exportSession(ctx, id);
      this.message = await FastLocalActions.copyText(archive) ?
        '已复制这条对话,在另一台设备的「导入对话」里粘贴' : '没复制上,再试一次';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async duplicateSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const copy = await sessionStore.duplicate(ctx, id);
      this.groups = this.visibleGroups(this.query);
      this.openSession(copy.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private openSession(id: string): void {
    this.sessionId = id;
    LocalChatLaunch.sessionId = id;

  }
}
