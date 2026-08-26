import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { providerStore } from '../store/ProviderStore';
import { Copy } from '../theme/Copy';
import { SettingsRow } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct SettingsPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @State providerLine: string = '还没有供应商';
  @State query: string = '';

  aboutToAppear(): void {
    this.refreshLine();
  }

  onProviderTick(): void {
    this.refreshLine();
  }

  private refreshLine(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    providerStore.ensureLoaded(ctx).then(() => {
      const active = providerStore.active();
      this.providerLine = active ? `${active.label} · ${active.model}` : '添加 OpenAI / Claude / Gemini / Grok';
    });
  }

  build() {
    Scroll() {
      Column() {
        Text('设置')
          .fontSize(26)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .width('100%')
          .padding({ bottom: 12 })
        TextInput({ placeholder: Copy.settingsSearch, text: this.query })
          .onChange((value: string) => {
            this.query = value;
          })
          .height(40)
          .width('100%')
          .margin({ bottom: 10 })
          .backgroundColor(Tokens.surface)
          .fontColor(Tokens.text)
          .placeholderColor(Tokens.muted)
          .borderRadius(12)
          .padding({ left: 14, right: 14 })

        if (this.hit('远程机器', '中继', '当身体', Copy.sectionDevice)) {
          this.section(Copy.sectionDevice)
        }
        Column() {
          if (this.hit('远程机器', '远程发任务、看进度、审批和停止')) {
            SettingsRow({
              icon: 'laptop',
              color: '#30B0C7',
              title: '远程机器',
              subtitle: '远程发任务、看进度、审批和停止',
              onOpen: () => {
                router.pushUrl({ url: 'pages/FleetPage' });
              }
            })
          }
          if (this.hit('中继', '远程入口的根和钥匙')) {
            SettingsRow({
              icon: 'share',
              color: '#30B0C7',
              title: '中继',
              subtitle: '远程入口的根和钥匙',
              onOpen: () => {
                router.pushUrl({ url: 'pages/RelayPage' });
              }
            })
          }
          if (this.hit('当身体', '给 iPhone 指挥这台鸿蒙')) {
            SettingsRow({
              icon: 'phone',
              color: '#30B0C7',
              title: '当身体',
              subtitle: '给 iPhone 指挥这台鸿蒙',
              onOpen: () => {
                router.pushUrl({ url: 'pages/BodyPage' });
              }
            })
          }
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        if (this.hit('供应商', '模型组', '技能', '人格', '记忆', '环境变量', 'MCP', '定时', Copy.sectionAgent)) {
          this.section(Copy.sectionAgent)
        }
        Column() {
          if (this.hit('管理供应商', this.providerLine)) {
            SettingsRow({
              icon: 'web',
              color: '#007AFF',
              title: '管理供应商',
              subtitle: this.providerLine,
              onOpen: () => {
                router.pushUrl({ url: 'pages/ProviderListPage' });
              }
            })
          }
          if (this.hit('模型组', '一组模型，失败按顺序换')) {
            SettingsRow({
              icon: 'copy',
              color: '#007AFF',
              title: '模型组',
              subtitle: '一组模型，失败按顺序换',
              onOpen: () => {
                router.pushUrl({ url: 'pages/ModelGroupsPage' });
              }
            })
          }
          if (this.hit('技能', '启用后注入本机对话')) {
            SettingsRow({
              icon: 'ok',
              color: '#007AFF',
              title: '技能',
              subtitle: '启用后注入本机对话',
              onOpen: () => {
                router.pushUrl({ url: 'pages/SkillsPage' });
              }
            })
          }
          if (this.hit('人格', 'SOUL.md，写给本机 Agent 的性格')) {
            SettingsRow({
              icon: 'voice',
              color: Tokens.accent,
              title: '人格',
              subtitle: 'SOUL.md，写给本机 Agent 的性格',
              onOpen: () => {
                router.pushUrl({ url: 'pages/SoulPage' });
              }
            })
          }
          if (this.hit('记忆', 'GLOBAL.md 与今日记忆')) {
            SettingsRow({
              icon: 'edit',
              color: Tokens.heroA,
              title: '记忆',
              subtitle: 'GLOBAL.md 与今日记忆',
              onOpen: () => {
                router.pushUrl({ url: 'pages/MemoryPage' });
              }
            })
          }
          if (this.hit('环境变量', '注入本机对话')) {
            SettingsRow({
              icon: 'copy',
              color: '#34C759',
              title: '环境变量',
              subtitle: '注入本机对话',
              onOpen: () => {
                router.pushUrl({ url: 'pages/EnvPage' });
              }
            })
          }
          if (this.hit('MCP', 'HTTP JSON-RPC，没有 Linux 进程')) {
            SettingsRow({
              icon: 'scan',
              color: '#34C759',
              title: 'MCP',
              subtitle: 'HTTP JSON-RPC，没有 Linux 进程',
              onOpen: () => {
                router.pushUrl({ url: 'pages/McpPage' });
              }
            })
          }
          if (this.hit('定时任务', '前台到点执行，杀进程不跑')) {
            SettingsRow({
              icon: 'clock',
              color: '#34C759',
              title: '定时任务',
              subtitle: '前台到点执行，杀进程不跑',
              onOpen: () => {
                router.pushUrl({ url: 'pages/SchedulePage' });
              }
            })
          }
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        if (this.hit('外观', '主动卡', '本机运行时', Copy.sectionAppearance, Copy.homeCardsTitle)) {
          this.section(Copy.sectionAppearance)
        }
        Column() {
          if (this.hit('外观', '跟随系统 / 浅色 / 深色', Copy.homeCardsTitle, '主动卡')) {
            SettingsRow({
              icon: 'albums',
              color: '#5856D6',
              title: '外观',
              subtitle: '跟随系统 / 浅色 / 深色',
              onOpen: () => {
                router.pushUrl({ url: 'pages/AppearancePage' });
              }
            })
          }
          if (this.hit('本机运行时', '语音、Push、无障碍、Linux 墙')) {
            SettingsRow({
              icon: 'restore',
              color: '#34C759',
              title: '本机运行时',
              subtitle: '语音、Push、无障碍、Linux 墙',
              onOpen: () => {
                router.pushUrl({ url: 'pages/RuntimePage' });
              }
            })
          }
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)

        if (this.hit('沙箱文件', '藏宝阁', '用量', Copy.sectionData)) {
          this.section(Copy.sectionData)
        }
        Column() {
          if (this.hit('沙箱文件', '只读列举应用沙箱，写文件默认询问')) {
            SettingsRow({
              icon: 'more',
              color: Tokens.online,
              title: '沙箱文件',
              subtitle: '只读列举应用沙箱，写文件默认询问',
              onOpen: () => {
                router.pushUrl({ url: 'pages/WorkspacePage' });
              }
            })
          }
          if (this.hit('藏宝阁', '笔记和摘录')) {
            SettingsRow({
              icon: 'albums',
              color: Tokens.warn,
              title: '藏宝阁',
              subtitle: '笔记和摘录',
              onOpen: () => {
                router.pushUrl({ url: 'pages/CollectionsPage' });
              }
            })
          }
          if (this.hit('用量', '本机会话统计')) {
            SettingsRow({
              icon: 'text',
              color: '#007AFF',
              title: '用量',
              subtitle: '本机会话统计',
              onOpen: () => {
                router.pushUrl({ url: 'pages/UsagePage' });
              }
            })
          }
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        Text(Copy.noLinux)
          .fontSize(12)
          .fontColor(Tokens.muted)
          .padding({ left: 14, right: 14, bottom: 8 })

        Column() {
          Text(`版本 ${ReleaseCatalog.currentVersion}  ·  ${ReleaseCatalog.currentBuild}`)
            .fontSize(14)
            .fontColor(Tokens.text)
          Text('本机 Agent：设备码、语音、Push token、多供应商、模型组失败换、官方 Anthropic/Gemini、Markdown、识图落盘、用量 token、浏览器、HTTP MCP、前台定时。远程机器仍是第二个入口。')
            .fontSize(13)
            .fontColor(Tokens.muted)
            .margin({ top: 8 })
          Text(Copy.pushB)
            .fontSize(13)
            .fontColor(Tokens.warn)
            .margin({ top: 8 })
          Text('查看本次更新')
            .fontColor(Tokens.accent)
            .margin({ top: 14 })
            .onClick(() => {
              router.pushUrl({ url: 'pages/ReleaseNotesPage' });
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(14)
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 8, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .scrollBar(BarState.Off)
    .align(Alignment.Top)
  }

  private hit(a: string, b: string = '', c: string = '', d: string = '', e: string = '',
    f: string = '', g: string = '', h: string = '', i: string = ''): boolean {
    const q = this.query.trim().toLowerCase();
    if (q.length === 0) {
      return true;
    }
    const bag: string[] = [a, b, c, d, e, f, g, h, i];
    for (let n = 0; n < bag.length; n++) {
      if (bag[n].toLowerCase().indexOf(q) >= 0) {
        return true;
      }
    }
    return false;
  }

  @Builder
  section(title: string) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.muted)
      .width('100%')
      .padding({ top: 22, bottom: 8 })
  }
}
