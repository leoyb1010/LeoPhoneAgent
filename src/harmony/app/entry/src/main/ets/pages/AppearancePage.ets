import { AppNavigation } from '../navigation/AppNavigation';
import { SurfaceButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';
import { themeStore } from '../store/ThemeStore';
import { Copy } from '../theme/Copy';
import { IconCircle, NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';
import { Sym } from '../theme/Symbols';

@Component
export struct AppearancePage {
  @StorageProp('themeTick') tick: number = 0;
  @State saving: boolean = false;
  @State message: string = '';
  @State mode: string = 'system';
  @State launch: string = 'auto';
  @State returnSend: boolean = false;
  @State keepAwake: boolean = false;
  @State toolPreview: boolean = true;
  @State expandThinking: boolean = true;
  @State showTitle: boolean = true;
  @State homeCards: boolean = true;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.load(ctx).then(() => {
      this.sync();
    });
  }

  @Builder
  choiceContent(value: string, current: () => string, title: string, subtitle: string, icon: string) {
      Row() {
        Sym({ name: icon === 'restore' ? 'arrow_counterclockwise' : icon === 'add' ? 'plus' : icon === 'text' ? 'doc_text' : icon === 'up' ? 'arrow_up' : icon, dim: Tokens.settingsGlyph, color: Tokens.reactive(this.tick, Tokens.secondary) })
        Column({ space: 3 }) {
          Text(title).fontSize(Tokens.rowTitle).fontColor(Tokens.reactive(this.tick, Tokens.text))
          Text(subtitle).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.secondary))
        }.alignItems(HorizontalAlign.Start).margin({ left: Tokens.rowGap }).layoutWeight(1)
        if (current() === value) Sym({ name: 'checkmark', dim: 19, color: Tokens.reactive(this.tick, Tokens.accent) })
      }.width('100%').padding({ left: 14, right: 14, top: 12, bottom: 12 }).constraintSize({ minHeight: 56 })

  }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '外观' })
      Scroll() {
        Column() {
          Text('跟随系统，或锁定浅色 / 深色。')
            .fontSize(13)
            .fontColor(Tokens.reactive(this.tick, Tokens.muted))
            .width('100%')
            .padding({ bottom: 16 })

          if (this.message) Text(this.message).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.danger)).width('100%').padding({ bottom: 12 })
          this.section('主题')
          Column() {
            this.choice('system', () => this.mode, '跟随系统', '和手机深浅色一致', Tokens.secondary, 'display',
              () => {
                this.pickMode('system');
              })
            this.choice('light', () => this.mode, '浅色', '暖白底色与柔和层次', Tokens.secondary, 'sun_max',
              () => {
                this.pickMode('light');
              })
            this.choice('dark', () => this.mode, '深色', '石墨底色与柔和对比', Tokens.secondary, 'moon',
              () => {
                this.pickMode('dark');
              })
          }
          .width('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
          .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
          .borderRadius(Tokens.settingsRadius)

          this.section('打开 App 时')
          Column() {
            this.choice('auto', () => this.launch, '自动', '一天内回到上次的对话，否则停在首页', Tokens.secondary, 'restore',
              () => {
                this.pickLaunch('auto');
              })
            this.choice('last', () => this.launch, '上次对话', '打开最近一条', Tokens.secondary, 'clock',
              () => {
                this.pickLaunch('last');
              })
            this.choice('new', () => this.launch, '新任务', '每次开一条新对话', Tokens.secondary, 'add',
              () => {
                this.pickLaunch('new');
              })
            this.choice('home', () => this.launch, '首页', '停在对话列表', Tokens.secondary, 'house',
              () => {
                this.pickLaunch('home');
              })
          }
          .width('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
          .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
          .borderRadius(Tokens.settingsRadius)

          this.section('回车键')
          Column() {
            this.choice('nl', () => this.returnSend ? 'send' : 'nl', '换行', '回车插入换行', Tokens.secondary, 'text',
              () => {
                this.pickReturn(false);
              })
            this.choice('send', () => this.returnSend ? 'send' : 'nl', '发送', '回车发出去', Tokens.secondary, 'up',
              () => {
                this.pickReturn(true);
              })
          }
          .width('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
          .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
          .borderRadius(Tokens.settingsRadius)

          this.section('对话')
          Column() {
            this.toggle('显示对话标题', () => this.showTitle, (on: boolean) => {
              this.showTitle = on;
              this.persist();
            })
            this.toggle('自动展开推理', () => this.expandThinking, (on: boolean) => {
              this.expandThinking = on;
              this.persist();
            })
            this.toggle('工具预览', () => this.toolPreview, (on: boolean) => {
              this.toolPreview = on;
              this.persist();
            })
            this.toggle('保持屏幕常亮', () => this.keepAwake, (on: boolean) => {
              this.keepAwake = on;
              this.persist();
            })
          }
          .width('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
          .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
          .borderRadius(Tokens.settingsRadius)

          this.section('主动卡')
          Text(Copy.homeCardsFooter)
            .fontSize(12)
            .fontColor(Tokens.reactive(this.tick, Tokens.muted))
            .width('100%')
            .padding({ bottom: 8 })
          Column() {
            this.toggle(Copy.homeCardsTitle, () => this.homeCards, (on: boolean) => {
              this.homeCards = on;
              this.persist();
            })
          }
          .width('100%')
          .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
          .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
          .borderRadius(Tokens.settingsRadius)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .constraintSize({ maxWidth: 560 })
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 32 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.reactive(this.tick, Tokens.grouped))

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  @Builder
  section(title: string) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.reactive(this.tick, Tokens.muted))
      .width('100%')
      .padding({ top: 22, bottom: 8 })
  }

  @Builder
  choice(value: string, current: () => string, title: string, subtitle: string, color: string,
    icon: string, onPick: () => void) {
    SurfaceButton({ content: () => { this.choiceContent(value, current, title, subtitle, icon); } }).width('100%').padding(0).borderRadius(0).backgroundColor(Tokens.reactive(this.tick, Tokens.transparent)).enabled(!this.saving)
      .accessibilityText(title).accessibilityDescription(subtitle).onClick(() => onPick())
  }

  @Builder
  toggle(title: string, on: () => boolean, onChange: (value: boolean) => void) {
    Row() {
      Text(title)
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.reactive(this.tick, Tokens.text))
        .layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: on() })
        .enabled(!this.saving).accessibilityText(title).onChange(onChange)
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
    this.homeCards = themeStore.homeCards;
  }

  private persist(): void {
    if (this.saving) { this.sync(); return; }
    this.saving = true; this.message = '';
    const ctx = getContext(this) as common.UIAbilityContext;
    themeStore.mode = this.mode;
    themeStore.launch = this.launch;
    themeStore.returnSend = this.returnSend;
    themeStore.keepAwake = this.keepAwake;
    themeStore.toolPreview = this.toolPreview;
    themeStore.expandThinking = this.expandThinking;
    themeStore.showTitle = this.showTitle;
    themeStore.homeCards = this.homeCards;
    themeStore.save(ctx).then(() => { this.sync(); this.message = themeStore.nativeError; }).catch(async (error: Error) => {
      await themeStore.reload(ctx); this.sync(); this.message = error.message;
    }).finally(() => { this.saving = false; });
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
