import { common } from '@kit.AbilityKit';
import { themeStore } from '../store/ThemeStore';
import { IconCircle } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct AppearancePage {
  @StorageProp('themeTick') tick: number = 0;
  @State mode: string = 'system';
  @State launch: string = 'auto';
  @State returnSend: boolean = false;
  @State keepAwake: boolean = false;
  @State toolPreview: boolean = true;
  @State expandThinking: boolean = true;
  @State showTitle: boolean = true;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.load(ctx).then(() => {
      this.sync();
    });
  }

  build() {
    Scroll() {
      Column() {
        Text('外观')
          .fontSize(Tokens.title)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
          .width('100%')
          .padding({ bottom: 8 })
        Text('跟 Fold8 一样：跟随系统，或锁定浅色 / 深色。')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ bottom: 16 })

        this.section('主题')
        Column() {
          this.choice('system', this.mode, '跟随系统', '和手机深浅色一致', '#5856D6', 'albums',
            () => {
              this.pickMode('system');
            })
          this.choice('light', this.mode, '浅色', '白底、系统灰分层', '#FF9500', 'albums',
            () => {
              this.pickMode('light');
            })
          this.choice('dark', this.mode, '深色', '纯黑底、分层抬亮', '#5856D6', 'more',
            () => {
              this.pickMode('dark');
            })
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        this.section('启动会话')
        Column() {
          this.choice('auto', this.launch, '自动', '系统决定', '#007AFF', 'restore',
            () => {
              this.pickLaunch('auto');
            })
          this.choice('last', this.launch, '上次会话', '打开最近一条', '#5AC8FA', 'clock',
            () => {
              this.pickLaunch('last');
            })
          this.choice('new', this.launch, '新任务', '每次开一条空会话', '#34C759', 'add',
            () => {
              this.pickLaunch('new');
            })
          this.choice('home', this.launch, '主页', '停在会话列表', '#007AFF', 'more',
            () => {
              this.pickLaunch('home');
            })
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        this.section('回车键')
        Column() {
          this.choice('nl', this.returnSend ? 'send' : 'nl', '换行', '回车插入换行', '#007AFF', 'text',
            () => {
              this.pickReturn(false);
            })
          this.choice('send', this.returnSend ? 'send' : 'nl', '发送', '回车发出去', '#007AFF', 'up',
            () => {
              this.pickReturn(true);
            })
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        this.section('对话')
        Column() {
          this.toggle('显示会话标题', this.showTitle, (on: boolean) => {
            this.showTitle = on;
            this.persist();
          })
          this.toggle('自动展开推理', this.expandThinking, (on: boolean) => {
            this.expandThinking = on;
            this.persist();
          })
          this.toggle('工具预览', this.toolPreview, (on: boolean) => {
            this.toolPreview = on;
            this.persist();
          })
          this.toggle('保持屏幕常亮', this.keepAwake, (on: boolean) => {
            this.keepAwake = on;
            this.persist();
          })
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  @Builder
  section(title: string) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.muted)
      .width('100%')
      .padding({ top: 22, bottom: 8 })
  }

  @Builder
  choice(value: string, current: string, title: string, subtitle: string, color: string,
    icon: string, onPick: () => void) {
    Row() {
      IconCircle({
        box: Tokens.settingsIcon,
        glyph: Tokens.settingsGlyph,
        color: color,
        icon: icon
      })
      Column() {
        Text(title)
          .fontSize(Tokens.rowTitle)
          .fontColor(Tokens.text)
        Text(subtitle)
          .fontSize(12)
          .fontColor(Tokens.muted)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: Tokens.rowGap })
      .layoutWeight(1)
      if (current === value) {
        Text('✓')
          .fontSize(18)
          .fontColor(Tokens.link)
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .onClick(() => {
      onPick();
    })
  }

  @Builder
  toggle(title: string, on: boolean, onChange: (value: boolean) => void) {
    Row() {
      Text(title)
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.text)
        .layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: on })
        .onChange(onChange)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
  }

  private sync(): void {
    this.mode = themeStore.mode;
    this.launch = themeStore.launch;
    this.returnSend = themeStore.returnSend;
    this.keepAwake = themeStore.keepAwake;
    this.toolPreview = themeStore.toolPreview;
    this.expandThinking = themeStore.expandThinking;
    this.showTitle = themeStore.showTitle;
  }

  private persist(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.mode = this.mode;
    themeStore.launch = this.launch;
    themeStore.returnSend = this.returnSend;
    themeStore.keepAwake = this.keepAwake;
    themeStore.toolPreview = this.toolPreview;
    themeStore.expandThinking = this.expandThinking;
    themeStore.showTitle = this.showTitle;
    themeStore.save(ctx);
    this.sync();
  }

  private pickMode(mode: string): void {
    this.mode = mode;
    this.persist();
  }

  private pickLaunch(launch: string): void {
    this.launch = launch;
    this.persist();
  }

  private pickReturn(send: boolean): void {
    this.returnSend = send;
    this.persist();
  }
}
