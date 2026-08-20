import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { LocalChatLaunch, LocalChatPane } from './LocalChatPane';
import { relativeTime } from '../local/LocalProtocol';
import { sessionStore, LocalSession, LocalSessionSummary, SessionGroup } from '../store/SessionStore';
import { providerStore, ProviderLaunch } from '../store/ProviderStore';
import { themeStore } from '../store/ThemeStore';
import { Copy } from '../theme/Copy';
import { IconBtn, IconCircle, SysIcon } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct LocalAgentPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @Prop wide: boolean = false;
  onRemote: () => void = () => {};
  onSettings: () => void = () => {};
  @State sessionId: string = '';
  @State groups: SessionGroup[] = [];
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
  private launched: boolean = false;

  aboutToAppear(): void {
    this.reload();
  }

  onProviderTick(): void {
    this.reload();
  }

  build() {
    if (this.wide) {
      Row() {
        Column() {
          this.listColumn()
        }
        .layoutWeight(1)
        Column()
          .width(Tokens.divider)
          .height('100%')
          .backgroundColor(Tokens.surface2)
        LocalChatPane({ sessionId: this.sessionId, compact: true })
          .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
    } else {
      this.listColumn()
    }
  }

  @Builder
  listColumn() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        if (this.wide) {
          this.wideHeader()
        }
        if (this.message.length > 0) {
          Text(this.message)
            .fontSize(Tokens.time)
            .fontColor(Tokens.warn)
            .width('100%')
            .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
        }
        Scroll() {
          Column() {
            if (this.groups.length === 0) {
              this.emptyState()
            } else {
              ForEach(this.groups, (group: SessionGroup) => {
                this.section(group)
              }, (group: SessionGroup) => group.key)
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ bottom: 96 })
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .align(Alignment.Top)
      }
      .width('100%')
      .height('100%')

      if (this.ready && this.configured && (this.hasSessions() || this.searchOpen)) {
        this.fabRow()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .bindSheet($$this.importOpen, this.importSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true
    })
    .bindSheet($$this.menuOpen, this.menuSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true
    })
  }

  @Builder
  wideHeader() {
    Row() {
      Text('Leo')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
      Blank()
      Text('导入')
        .fontSize(Tokens.time)
        .fontColor(Tokens.accent)
        .margin({ right: 14 })
        .onClick(() => {
          this.importOpen = true;
        })
      Text('远程')
        .fontSize(14)
        .fontColor(Tokens.muted)
        .margin({ right: 14 })
        .onClick(() => {
          this.onRemote();
        })
      this.settingsDot()
    }
    .width('100%')
    .height(Tokens.topBar)
    .alignItems(VerticalAlign.Center)
    .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
  }

  @Builder
  settingsDot() {
    IconBtn({
      name: 'more',
      box: Tokens.settingsIcon,
      glyph: Tokens.settingsGlyph,
      color: Tokens.accent,
      fill: Tokens.surface2,
      onTap: () => {
        this.onSettings();
      }
    })
  }

  @Builder
  fabRow() {
    Row() {
      this.plusFab()
      if (this.searchOpen) {
        TextInput({ placeholder: Copy.searchPlaceholder, text: this.query })
          .onChange((value: string) => {
            this.query = value;
            this.groups = sessionStore.grouped(this.query);
          })
          .height(Tokens.searchField)
          .layoutWeight(1)
          .margin({ left: 10, right: 10 })
          .backgroundColor(Tokens.surface)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(Tokens.searchField / 2)
        Stack() {
          SysIcon({
            name: 'close',
            dim: 20,
            color: Tokens.muted
          })
        }
        .width(Tokens.fabSize)
        .height(Tokens.fabSize)
        .onClick(() => {
          this.query = '';
          this.searchOpen = false;
          this.groups = sessionStore.grouped('');
        })
      } else if (this.hasSessions()) {
        this.searchFab()
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.SpaceBetween)
    .alignItems(VerticalAlign.Center)
    .padding({ left: Tokens.fabPadH, right: Tokens.fabPadH, top: Tokens.fabPadV, bottom: Tokens.fabPadV })
  }

  @Builder
  plusFab() {
    Stack() {
      Column()
        .width(Tokens.fabSize)
        .height(Tokens.fabSize)
        .borderRadius(Tokens.fabSize / 2)
        .backgroundColor(Tokens.fab)
        .shadow({ radius: 8, color: '#33000000', offsetY: 4 })
      SysIcon({
        name: 'add',
        dim: Tokens.fabGlyph,
        color: '#FFFFFF'
      })
    }
    .width(Tokens.fabSize)
    .height(Tokens.fabSize)
    .onClick(() => {
      this.createSession();
    })
  }

  @Builder
  searchFab() {
    Text('搜索')
      .fontSize(15)
      .fontColor(Tokens.text)
      .fontWeight(FontWeight.Medium)
      .padding({ left: 18, right: 18, top: 12, bottom: 12 })
      .backgroundColor(Tokens.surface)
      .borderRadius(22)
      .shadow({ radius: 6, color: '#26000000', offsetY: 3 })
      .onClick(() => {
        this.searchOpen = true;
      })
  }

  @Builder
  section(group: SessionGroup) {
    Column() {
      Row() {
        if (group.key === 'pinned') {
          Text('📌')
            .fontSize(Tokens.section)
            .margin({ right: 4 })
        }
        Text(group.title)
          .fontSize(Tokens.section)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.muted)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({
        left: Tokens.pagePad,
        right: Tokens.pagePad,
        top: 16,
        bottom: 8
      })
      Column() {
        ForEach(group.rows, (row: LocalSessionSummary) => {
          this.sessionRow(row)
        }, (row: LocalSessionSummary) => row.id)
      }
      .width('100%')
      .backgroundColor(Tokens.surface)
      .borderRadius(Tokens.cardRadius)
      .clip(true)
      .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sessionRow(row: LocalSessionSummary) {
    Row() {
      IconCircle({
        color: Tokens.chatMark,
        icon: 'email',
        pinned: row.pinned
      })
      Column() {
        Text(row.title)
          .fontSize(Tokens.rowTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(row.lastMessage.length > 0 ? row.lastMessage : '还没有消息')
          .fontSize(Tokens.rowSub)
          .fontColor(Tokens.muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 1 })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: Tokens.rowGap })
      .layoutWeight(1)
      Text(relativeTime(row.updatedAt))
        .fontSize(Tokens.time)
        .fontColor(Tokens.muted)
        .margin({ left: 8 })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({
      left: 14,
      right: 14,
      top: Tokens.rowVPad,
      bottom: Tokens.rowVPad
    })
    .backgroundColor(this.sessionId === row.id ? Tokens.surface2 : '#00000000')
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
  emptyState() {
    Column() {
      Stack() {
        Column()
          .width(Tokens.hero)
          .height(Tokens.hero)
          .borderRadius(Tokens.heroRadius)
          .linearGradient({
            angle: 135,
            colors: [[Tokens.heroA, 0], [Tokens.heroB, 1]]
          })
        Text('本')
          .fontSize(Tokens.heroGlyph)
          .fontColor('#FFFFFF')
          .fontWeight(FontWeight.Bold)
      }
      .width(Tokens.hero)
      .height(Tokens.hero)
      .margin({ bottom: 20 })

      Text(Copy.welcomeTitle)
        .fontSize(Tokens.welcome)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .textAlign(TextAlign.Center)
      Text(Copy.welcomeSubtitle)
        .fontSize(14)
        .fontColor(Tokens.muted)
        .textAlign(TextAlign.Center)
        .margin({ top: 8, bottom: 26 })
      Row() {
        Column()
          .width(7)
          .height(7)
          .borderRadius(3.5)
          .backgroundColor(Tokens.stepGreen)
        Text(Copy.localRuntime)
          .fontSize(Tokens.pill)
          .fontColor(Tokens.muted)
          .fontWeight(FontWeight.Medium)
          .margin({ left: 7 })
      }
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .backgroundColor(Tokens.surface)
      .borderRadius(50)
      .margin({ bottom: 22 })
      this.stepCard('1', Copy.step1, this.configured ? Copy.stepDone : Copy.step1sub, this.configured, false)
      this.stepCard('2', Copy.step2, this.step2Sub(), false, !this.configured)
      this.stepCard('3', Copy.step3, this.configured ? Copy.step3sub : Copy.stepLocked, false, !this.configured)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: this.wide ? 24 : 22, bottom: 48 })
  }

  @Builder
  stepCard(index: string, title: string, subtitle: string, done: boolean, locked: boolean) {
    Row() {
      Stack() {
        Column()
          .width(Tokens.stepIcon)
          .height(Tokens.stepIcon)
          .borderRadius(Tokens.stepRadius)
          .backgroundColor(done ? Tokens.stepGreen : (locked ? Tokens.surface2 : Tokens.heroA))
        Text(done ? '✓' : index)
          .fontSize(15)
          .fontColor('#FFFFFF')
          .fontWeight(FontWeight.Medium)
      }
      .width(Tokens.stepIcon)
      .height(Tokens.stepIcon)
      Column() {
        Text(title)
          .fontSize(Tokens.rowTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(done ? Tokens.muted : Tokens.text)
        Text(subtitle)
          .fontSize(12)
          .fontColor(Tokens.muted)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .justifyContent(FlexAlign.Center)
      .height(52)
      .margin({ left: 14 })
      .layoutWeight(1)
      if (!done && !locked) {
        Text('›')
          .fontSize(18)
          .fontColor(Tokens.muted)
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .margin({ bottom: 10 })
    .backgroundColor(Tokens.surface)
    .borderRadius(18)
    .opacity(locked ? 0.55 : 1)
    .onClick(() => {
      if (index === '1') {
        this.onSettings();
      } else if (index === '2') {
        this.openModelPick();
      } else if (index === '3' && this.configured) {
        this.createSession();
      }
    })
  }

  @Builder
  importSheet() {
    Column() {
      Text('导入会话')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .margin({ bottom: 10 })
      Text('只接受带 messages 的 JSON。没有消息的档案不会建空会话。')
        .fontSize(12)
        .fontColor(Tokens.muted)
        .width('100%')
        .margin({ bottom: 10 })
      TextArea({ placeholder: '{"messages":[{"role":"user","content":"..."}]}', text: this.importDraft })
        .onChange((value: string) => {
          this.importDraft = value;
        })
        .height(88)
        .backgroundColor(Tokens.bg)
        .fontColor(Tokens.text)
        .placeholderColor(Tokens.muted)
        .borderRadius(10)
      Button('导入')
        .width('100%')
        .height(40)
        .margin({ top: 8 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .onClick(() => {
          this.importSession();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(Tokens.pagePad)
    .backgroundColor(Tokens.surface)
  }

  @Builder
  menuSheet() {
    Column() {
      Text(this.menuTitle)
        .fontSize(Tokens.rowTitle)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .width('100%')
        .margin({ bottom: 12 })
      Text(this.menuPinned ? '取消置顶' : '置顶')
        .fontSize(16)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ top: 14, bottom: 14 })
        .onClick(() => {
          this.menuOpen = false;
          this.pinSession(this.menuId);
        })
      Text('复制会话')
        .fontSize(16)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ top: 14, bottom: 14 })
        .onClick(() => {
          this.menuOpen = false;
          this.duplicateSession(this.menuId);
        })
      Text('归档')
        .fontSize(16)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ top: 14, bottom: 14 })
        .onClick(() => {
          this.menuOpen = false;
          this.archiveSession(this.menuId);
        })
      Text('删除')
        .fontSize(16)
        .fontColor(Tokens.accent)
        .width('100%')
        .padding({ top: 14, bottom: 14 })
        .onClick(() => {
          this.menuOpen = false;
          this.removeSession(this.menuId);
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(Tokens.pagePad)
    .backgroundColor(Tokens.surface)
  }

  private applyLaunch(): void {
    if (this.launched || !this.configured) {
      return;
    }
    this.launched = true;
    if (themeStore.launch === 'new') {
      this.createSession();
      return;
    }
    if (themeStore.launch === 'last') {
      const id = this.lastSessionId();
      if (id.length > 0) {
        this.openSession(id);
      }
    }
  }

  private lastSessionId(): string {
    const rows = sessionStore.listActive();
    let best = '';
    let stamp = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].updatedAt > stamp) {
        stamp = rows[i].updatedAt;
        best = rows[i].id;
      }
    }
    return best;
  }

  private hasSessions(): boolean {
    return this.groups.length > 0;
  }

  private step2Sub(): string {
    if (this.configured && this.modelLine.length > 0) {
      return `当前 ${this.modelLine}，点这里换`;
    }
    return Copy.stepLocked;
  }

  private openModelPick(): void {
    const row = providerStore.active();
    if (row) {
      ProviderLaunch.id = row.id;
      router.pushUrl({ url: 'pages/ProviderDetailPage' });
      return;
    }
    router.pushUrl({ url: 'pages/ProviderListPage' });
  }

  private reload(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    Promise.all([
      providerStore.ensureLoaded(ctx),
      sessionStore.ensureLoaded(ctx)
    ]).then(() => {
      this.configured = providerStore.configured();
      const active = providerStore.active();
      this.modelLine = active ? active.model : '';
      this.groups = sessionStore.grouped(this.query);
      this.ready = true;
      if (sessionStore.jsonLoadFailed) {
        this.message = '会话档案读坏了，先别保存，避免覆盖';
      }
      this.applyLaunch();
    }).catch((err: Error) => {
      this.message = `${err}`;
    });
  }

  private async createSession(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const session = await sessionStore.create(ctx);
      this.groups = sessionStore.grouped(this.query);
      this.openSession(session.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async importSession(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const session: LocalSession = await sessionStore.importArchive(ctx, this.importDraft);
      this.importDraft = '';
      this.importOpen = false;
      this.groups = sessionStore.grouped(this.query);
      this.openSession(session.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async pinSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await sessionStore.togglePin(ctx, id);
      this.groups = sessionStore.grouped(this.query);
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
      this.groups = sessionStore.grouped(this.query);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async removeSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await sessionStore.remove(ctx, id);
      if (this.sessionId === id) {
        this.sessionId = '';
      }
      this.groups = sessionStore.grouped(this.query);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async duplicateSession(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const copy = await sessionStore.duplicate(ctx, id);
      this.groups = sessionStore.grouped(this.query);
      this.openSession(copy.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private openSession(id: string): void {
    this.sessionId = id;
    LocalChatLaunch.sessionId = id;
    if (!this.wide) {
      router.pushUrl({ url: 'pages/LocalChatPage' });
    }
  }
}
