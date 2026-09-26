import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
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

/** 对话头像的颜色:按标题挑一个,同一个对话每次一样。 */
const AVATAR_COLORS: string[] = ['#2E8B8B', '#5B7CFA', '#8E6CEF', '#F08A24', '#E5577A', '#34A853', '#0FA3C8'];

function avatarColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** 一行对话的 key:画面上用到的都在里面(鸿蒙 ForEach key 不变就不重画,改了标题也还显示旧的)。 */
function sessionKey(row: LocalSessionSummary): string {
  return `${row.id}|${row.title}|${row.updatedAt}|${row.pinned}|${row.lastMessage}`;
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
  @State activeIds: string[] = [];
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
  @State draft: string = '';
  @State homeFiles: string[] = [];
  @State homeImagePath: string = '';
  private homeImage: PendingImage | null = null;
  private launched: boolean = false;

  aboutToAppear(): void {
    this.activeIds = ChatRuns.activeIds();
    this.reload();
  }

  onProviderTick(): void {
    this.reload();
  }

  onTaskTick(): void {
    this.activeIds = ChatRuns.activeIds();
    this.groups = sessionStore.grouped(this.query);
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
    if (this.wide) {
      Row() {
        Column() {
          this.listColumn()
        }
        .width(this.listWidth())
        .height('100%')
        Column()
          .width(Tokens.hairline)
          .height('100%')
          .backgroundColor(Tokens.separator)
        if (this.sessionId.length > 0) {
          LocalChatPane({ sessionId: this.sessionId, compact: true })
            .layoutWeight(1)
        } else {
          this.pickHint()
        }
      }
      .width('100%')
      .height('100%')
    } else {
      this.listColumn()
    }
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
      Scroll() {
        Column() {
          if (!this.configured && this.ready) {
            this.onboarding()
          } else {
            this.statusChips()
            if (this.groups.length === 0 && this.ready) {
              this.emptyList()
            } else {
              ForEach(this.groups, (group: SessionGroup) => {
                this.section(group)
              }, (group: SessionGroup) => `${group.key}|${group.rows.map((row: LocalSessionSummary) => sessionKey(row)).join(',')}`)
            }
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: 24 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
      .edgeEffect(EdgeEffect.Spring)
      if (!this.wide && this.configured) {
        Column() {
          Composer({
            draft: $draft,
            placeholder: '问 Leo，或直接说要做的事',
            modelLabel: this.modelLine,
            showApproval: true,
            fullAuto: SensitiveToolGate.fullAuto && this.approvalTick >= 0,
            files: this.homeFiles,
            imagePath: this.homeImagePath,
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
              const ctx = getContext(this) as common.UIAbilityContext;
              SensitiveToolGate.setFullAuto(ctx, !SensitiveToolGate.fullAuto);
            },
            onRemoveFile: (index: number) => {
              this.homeFiles = this.homeFiles.filter((_name: string, i: number) => i !== index);
            },
            onRemoveImage: () => {
              this.homeImage = null;
              this.homeImagePath = '';
            }
          })
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 4, bottom: 10 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .bindSheet($$this.importOpen, this.importSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true,
      title: { title: '导入对话' }
    })
    .bindSheet($$this.menuOpen, this.menuSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true
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
      Text(this.wide ? '对话' : 'LeoPhoneAgent')
        .fontSize(this.wide ? 20 : 19)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ left: this.wide ? 10 : 4 })
        .layoutWeight(1)
      if (this.configured) {
        this.barIcon('magnifyingglass', () => {
          this.searchOpen = !this.searchOpen;
          if (!this.searchOpen) {
            this.query = '';
            this.groups = sessionStore.grouped('');
          }
        })
      }
      this.barIcon('computer', () => {
        this.onRemote();
      })
      if (this.wide && this.configured) {
        this.barIcon('square_and_pencil', () => {
          this.createSession();
        })
      }
      Stack() {
        Sym({ name: 'ellipsis_circle', dim: 21, color: Tokens.text })
      }
      .width(40)
      .height(40)
      .bindMenu(this.wide ? [
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
  searchBar() {
    Row() {
      Row() {
        Sym({ name: 'magnifyingglass', dim: 15, color: Tokens.muted })
        TextInput({ placeholder: Copy.searchPlaceholder, text: this.query })
          .onChange((value: string) => {
            this.query = value;
            this.groups = sessionStore.grouped(this.query);
          })
          .layoutWeight(1)
          .height(36)
          .fontSize(15)
          .backgroundColor('#00000000')
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .padding({ left: 6 })
      }
      .layoutWeight(1)
      .height(38)
      .padding({ left: 10, right: 6 })
      .backgroundColor(Tokens.surface)
      .borderRadius(19)
      Text('取消')
        .fontSize(15)
        .fontColor(Tokens.accent)
        .margin({ left: 12 })
        .onClick(() => {
          this.query = '';
          this.searchOpen = false;
          this.groups = sessionStore.grouped('');
        })
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
    .height(32)
    .padding({ left: 12, right: 12 })
    .backgroundColor(Tokens.surface)
    .borderRadius(16)
    .margin({ right: 8 })
    .onClick(() => {
      tap();
    })
  }

  @Builder
  section(group: SessionGroup) {
    Column() {
      Row() {
        if (group.key === 'pinned') {
          Sym({ name: 'pin_fill', dim: 12, color: Tokens.secondary })
            .margin({ right: 4 })
        }
        Text(group.title)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.secondary)
        Text(`${group.rows.length}`)
          .fontSize(12)
          .fontColor(Tokens.muted)
          .margin({ left: 6 })
      }
      .width('100%')
      .padding({ left: Tokens.pagePad + 4, right: Tokens.pagePad, top: 14, bottom: 4 })
      ForEach(group.rows, (row: LocalSessionSummary) => {
        this.sessionRow(row)
      }, (row: LocalSessionSummary) => sessionKey(row))
    }
    .width('100%')
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
        Text(row.lastMessage.length > 0 ? row.lastMessage : '暂无消息')
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
    .height(70)
    .padding({ left: this.wide ? 6 : 10, right: this.wide ? 10 : 16 })
    .margin({ left: this.wide ? 8 : 0, right: this.wide ? 8 : 0 })
    .backgroundColor(this.wide && this.sessionId === row.id ? Tokens.surface : '#00000000')
    .borderRadius(this.wide ? 14 : 0)
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
      Stack() {
        Column()
          .width(64)
          .height(64)
          .borderRadius(32)
          .backgroundColor(Tokens.accentSoft)
        Sym({ name: 'wand_and_stars_fill', dim: 28, color: Tokens.accent })
      }
      .width(64)
      .height(64)
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
    Column() {
      Sym({ name: 'text_bubble_left_2', dim: 40, color: Tokens.muted })
      Text('选一个对话，或新建一个')
        .fontSize(16)
        .fontColor(Tokens.secondary)
        .margin({ top: 12 })
      Text('新对话')
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor('#FFFFFF')
        .padding({ left: 18, right: 18, top: 9, bottom: 9 })
        .backgroundColor(Tokens.accent)
        .borderRadius(20)
        .margin({ top: 16 })
        .onClick(() => {
          this.createSession();
        })
    }
    .layoutWeight(1)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor(Tokens.bg)
  }

  @Builder
  onboarding() {
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
        Sym({ name: 'wand_and_stars_fill', dim: 32, color: '#FFFFFF' })
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
        .fontSize(15)
        .lineHeight(22)
        .fontColor(Tokens.secondary)
        .textAlign(TextAlign.Center)
        .margin({ top: 8, bottom: 22 })
      Row() {
        Column()
          .width(7)
          .height(7)
          .borderRadius(3.5)
          .backgroundColor(Tokens.stepGreen)
        Text(Copy.localRuntime)
          .fontSize(Tokens.pill)
          .fontColor(Tokens.secondary)
          .fontWeight(FontWeight.Medium)
          .margin({ left: 7 })
      }
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .backgroundColor(Tokens.surface)
      .borderRadius(50)
      .margin({ bottom: 24 })
      Column() {
        this.stepRow('1', Copy.step1, this.configured ? Copy.stepDone : Copy.step1sub, this.configured, false)
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .margin({ left: 66 })
        this.stepRow('2', Copy.step2, this.step2Sub(), false, !this.configured)
        Divider()
          .strokeWidth(Tokens.hairline)
          .color(Tokens.separator)
          .margin({ left: 66 })
        this.stepRow('3', Copy.step3, this.configured ? Copy.step3sub : Copy.stepLocked, false, !this.configured)
      }
      .width('100%')
      .backgroundColor(Tokens.surface)
      .borderRadius(Tokens.cardRadius)
    }
    .width('100%')
    .constraintSize({ maxWidth: 560 })
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: this.wide ? 24 : 36, bottom: 48 })
  }

  @Builder
  stepRow(index: string, title: string, subtitle: string, done: boolean, locked: boolean) {
    Row() {
      Stack() {
        Column()
          .width(Tokens.stepIcon)
          .height(Tokens.stepIcon)
          .borderRadius(Tokens.stepRadius)
          .backgroundColor(done ? Tokens.stepGreen : (locked ? Tokens.surface2 : Tokens.heroA))
        if (done) {
          Sym({ name: 'checkmark', dim: 16, color: '#FFFFFF' })
        } else {
          Text(index)
            .fontSize(15)
            .fontColor(locked ? Tokens.muted : '#FFFFFF')
            .fontWeight(FontWeight.Medium)
        }
      }
      .width(Tokens.stepIcon)
      .height(Tokens.stepIcon)
      Column() {
        Text(title)
          .fontSize(Tokens.rowTitle)
          .fontWeight(FontWeight.Medium)
          .fontColor(locked ? Tokens.muted : Tokens.text)
        Text(subtitle)
          .fontSize(12.5)
          .fontColor(Tokens.muted)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 14 })
      .layoutWeight(1)
      if (!done && !locked) {
        Sym({ name: 'chevron_right', dim: 13, color: Tokens.muted })
      }
    }
    .width('100%')
    .height(68)
    .padding({ left: 14, right: 14 })
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
        .fontColor('#FFFFFF')
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

  /** 展开的折叠屏(约 700–840vp)左边四成;再宽固定 360。 */
  private listWidth(): string | number {
    return '40%';
  }

  private async sendFromHome(): Promise<void> {
    const text = this.draft.trim();
    if (!text && !this.homeImage && this.homeFiles.length === 0) {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const session = await sessionStore.create(ctx);
      const first = new FirstMessage();
      first.sessionId = session.id;
      first.text = text;
      first.files = this.homeFiles;
      first.image = this.homeImage;
      LocalChatLaunch.first = first;
      this.draft = '';
      this.homeFiles = [];
      this.homeImage = null;
      this.homeImagePath = '';
      this.groups = sessionStore.grouped(this.query);
      this.openSession(session.id);
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async pickHomeImage(): Promise<void> {
    try {
      const image = await Attachments.pickImage(getContext(this) as common.UIAbilityContext);
      if (image) {
        this.homeImage = image;
        this.homeImagePath = image.path;
      }
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
        this.message = '对话档案读坏了，先别保存，避免覆盖';
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
      ChatRuns.forget(id);
      await sessionStore.remove(ctx, id);
      if (this.sessionId === id) {
        this.sessionId = '';
      }
      this.groups = sessionStore.grouped(this.query);
    } catch (err) {
      this.message = `${err}`;
    }
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
