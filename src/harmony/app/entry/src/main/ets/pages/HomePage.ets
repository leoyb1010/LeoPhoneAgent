import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { ReleaseNotesStore } from '../store/ReleaseNotesStore';

@Entry
@Component
struct HomePage {
  @State showNotes: boolean = false;
  @State notesTitle: string = '';
  @State notesLines: string[] = [];

  aboutToAppear(): void {
    const first = ReleaseCatalog.all()[0];
    this.notesTitle = first.title;
    this.notesLines = first.highlights;
    const ctx = getContext(this) as common.UIAbilityContext;
    ReleaseNotesStore.shouldShow(ctx).then((show: boolean) => {
      this.showNotes = show;
    });
  }

  build() {
    Column() {
      Column() {
        Text('LeoPhoneAgent')
          .fontSize(28)
          .fontWeight(FontWeight.Medium)
          .fontColor('#F2F2F4')
        Text(`${ReleaseCatalog.currentVersion}  ·  瘦控制面`)
          .fontSize(14)
          .fontColor('#8E8E93')
          .margin({ top: 6 })
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding({ left: 20, right: 20, top: 28, bottom: 20 })

      this.card('远程机器', '指挥在线的 Mac 或 Android 身体', () => {
        router.pushUrl({ url: 'pages/FleetPage' });
      })
      this.card('本机 Agent', '第二船，这版还没开', () => {
      }, true)
      this.card('设置', '中继根、钥匙、关于', () => {
        router.pushUrl({ url: 'pages/SettingsPage' });
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#121214')
    .bindSheet($$this.showNotes, this.notesSheet(), {
      height: SheetSize.MEDIUM,
      dragBar: true
    })
  }

  @Builder
  card(title: string, subtitle: string, action: () => void, disabled: boolean = false) {
    Column() {
      Text(title)
        .fontSize(18)
        .fontColor(disabled ? '#6E6E73' : '#F2F2F4')
      Text(subtitle)
        .fontSize(13)
        .fontColor('#8E8E93')
        .margin({ top: 6 })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(18)
    .margin({ left: 16, right: 16, bottom: 12 })
    .backgroundColor('#1C1C1E')
    .borderRadius(14)
    .onClick(() => {
      if (!disabled) {
        action();
      }
    })
  }

  @Builder
  notesSheet() {
    Column() {
      Text('本次更新')
        .fontSize(13)
        .fontColor('#8E8E93')
      Text(this.notesTitle)
        .fontSize(22)
        .fontColor('#F2F2F4')
        .margin({ top: 8, bottom: 16 })
      ForEach(this.notesLines, (line: string) => {
        Text(line)
          .fontSize(15)
          .fontColor('#D1D1D6')
          .margin({ bottom: 10 })
      }, (line: string) => line)
      Button('知道了')
        .width('100%')
        .height(44)
        .margin({ top: 12 })
        .backgroundColor('#E85030')
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
    .backgroundColor('#1C1C1E')
  }
}
