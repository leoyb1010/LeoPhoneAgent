import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import display from '@ohos.display';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { ReleaseNotesStore } from '../store/ReleaseNotesStore';
import { ChatLaunch } from '../net/HarnessClient';
import { FoldLayout } from '../layout/FoldLayout';
import { FleetPane } from '../panes/FleetPane';
import { ChatPane } from '../panes/ChatPane';
import { SettingsPane } from '../panes/SettingsPane';
import { LocalAgentPane } from '../panes/LocalAgentPane';
import { themeStore } from '../store/ThemeStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct HomePage {
  @StorageProp('themeTick') tick: number = 0;
  @State showNotes: boolean = false;
  @State notesTitle: string = '';
  @State notesLines: string[] = [];
  @State wide: boolean = false;
  @State tab: number = 0;
  @State chatMachine: string = '';
  @State chatLaunch: number = 0;
  /** 点通知回来要打开某个本机对话:先切到本机这一栏,LocalAgentPane 再打开它。 */
  @StorageProp('openSession') @Watch('onOpenSession') openRequest: string = '';
  private foldCb: ((status: display.FoldStatus) => void) | null = null;

  aboutToAppear(): void {
    const first = ReleaseCatalog.all()[0];
    this.notesTitle = first.title;
    this.notesLines = first.highlights;
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.load(ctx);
    ReleaseNotesStore.shouldShow(ctx).then((show: boolean) => {
      this.showNotes = show;
    });
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
    if (this.openRequest.length > 0) {
      this.tab = 0;
    }
  }

  onPageShow(): void {
    AppStorage.setOrCreate('providerTick', Date.now());
  }

  aboutToDisappear(): void {
    if (this.foldCb) {
      try {
        display.off('foldStatusChange', this.foldCb);
      } catch (_err) {
        // ignore
      }
    }
  }

  build() {
    Column() {
      if (this.wide) {
        this.wideBody()
      } else {
        LocalAgentPane({
          wide: false,
          onSettings: () => {
            router.pushUrl({ url: 'pages/SettingsPage' });
          },
          onRemote: () => {
            router.pushUrl({ url: 'pages/FleetPage' });
          }
        })
          .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .onAreaChange((_old: Area, now: Area) => {
      this.syncWide(Number(now.width), Number(now.height));
    })
    .bindSheet($$this.showNotes, this.notesSheet(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true
    })
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
            this.tab = 2;
          }
        })
          .width('40%')
        Column()
          .width(Tokens.hairline)
          .height('100%')
          .backgroundColor(Tokens.separator)
        ChatPane({ machine: this.chatMachine, launch: this.chatLaunch })
          .layoutWeight(1)
      }
      .width('100%')
      .layoutWeight(1)
    } else {
      LocalAgentPane({
        wide: true,
        onRemote: () => {
          this.tab = 1;
        },
        onSettings: () => {
          this.tab = 2;
        }
      })
        .layoutWeight(1)
    }
  }

  @Builder
  notesSheet() {
    Column() {
      Text('本次更新')
        .fontSize(13)
        .fontColor(Tokens.secondary)
      Text(this.notesTitle)
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .margin({ top: 6, bottom: 18 })
      ForEach(this.notesLines, (line: string) => {
        Row() {
          Column()
            .width(6)
            .height(6)
            .borderRadius(3)
            .backgroundColor(Tokens.accent)
            .margin({ top: 9 })
          Text(line)
            .fontSize(15)
            .lineHeight(23)
            .fontColor(Tokens.text)
            .margin({ left: 10 })
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)
        .margin({ bottom: 12 })
      }, (line: string) => line)
      Text('知道了')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor('#FFFFFF')
        .textAlign(TextAlign.Center)
        .width('100%')
        .height(48)
        .backgroundColor(Tokens.accent)
        .borderRadius(24)
        .margin({ top: 10 })
        .onClick(() => {
          const ctx = getContext(this) as common.UIAbilityContext;
          ReleaseNotesStore.markSeen(ctx).then(() => {
            this.showNotes = false;
          });
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 24, right: 24, top: 4, bottom: 28 })
  }


  private syncWide(width: number, height: number): void {
    this.wide = FoldLayout.isWide(width, height);
  }
}
