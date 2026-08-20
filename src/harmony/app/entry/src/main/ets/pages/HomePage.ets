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
    this.foldCb = (_status: display.FoldStatus) => {
      this.syncWide(0, 0);
    };
    try {
      display.on('foldStatusChange', this.foldCb);
    } catch (_err) {
      // non-fold devices
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
      if (!this.wide) {
        this.coverBar()
      }
      if (this.wide) {
        this.wideBody()
      } else {
        this.narrowBody()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .onAreaChange((_old: Area, now: Area) => {
      this.syncWide(Number(now.width), Number(now.height));
    })
    .bindSheet($$this.showNotes, this.notesSheet(), {
      height: SheetSize.MEDIUM,
      dragBar: true
    })
  }

  @Builder
  coverBar() {
    Row() {
      this.tabLabel('本机', 0)
      this.tabLabel('远程', 1)
      Blank()
      Text('设置')
        .fontSize(15)
        .fontColor(Tokens.accent)
        .fontWeight(FontWeight.Medium)
        .onClick(() => {
          router.pushUrl({ url: 'pages/SettingsPage' });
        })
    }
    .width('100%')
    .height(Tokens.topBar)
    .alignItems(VerticalAlign.Center)
    .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
  }

  @Builder
  tabLabel(title: string, index: number) {
    Text(title)
      .fontSize(this.tab === index ? Tokens.title : 16)
      .fontColor(this.tab === index ? Tokens.text : Tokens.muted)
      .fontWeight(this.tab === index ? FontWeight.Bold : FontWeight.Regular)
      .margin({ right: 18 })
      .onClick(() => {
        this.tab = index;
      })
  }

  @Builder
  wideBody() {
    if (this.tab === 2) {
      SettingsPane()
    } else if (this.tab === 1) {
      Row() {
        FleetPane({
          wide: true,
          onOpen: () => {
            this.chatMachine = ChatLaunch.machine;
          },
          onLocal: () => {
            this.tab = 0;
          },
          onSettings: () => {
            this.tab = 2;
          }
        })
          .layoutWeight(1)
        Column()
          .width(Tokens.divider)
          .height('100%')
          .backgroundColor(Tokens.surface2)
        ChatPane({ machine: this.chatMachine })
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
  narrowBody() {
    if (this.tab === 1) {
      FleetPane({
        onOpen: () => {
          this.chatMachine = ChatLaunch.machine;
          router.pushUrl({ url: 'pages/RemoteChatPage' });
        }
      })
        .layoutWeight(1)
    } else {
      LocalAgentPane({
        wide: false,
        onSettings: () => {
          router.pushUrl({ url: 'pages/SettingsPage' });
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
        .fontColor(Tokens.muted)
      Text(this.notesTitle)
        .fontSize(22)
        .fontColor(Tokens.text)
        .margin({ top: 8, bottom: 16 })
      ForEach(this.notesLines, (line: string) => {
        Text(line)
          .fontSize(15)
          .fontColor(Tokens.muted)
          .margin({ bottom: 10 })
      }, (line: string) => line)
      Button('知道了')
        .width('100%')
        .height(44)
        .margin({ top: 12 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .onClick(() => {
          const ctx = getContext(this) as common.UIAbilityContext;
          ReleaseNotesStore.markSeen(ctx).then(() => {
            this.showNotes = false;
          });
        })
    }
    .padding(20)
    .width('100%')
    .backgroundColor(Tokens.surface)
  }

  private syncWide(width: number, height: number): void {
    this.wide = FoldLayout.isWide(width, height);
  }
}
