import { themeStore } from '../store/ThemeStore';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';

import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { providerStore } from '../store/ProviderStore';
import { Copy } from '../theme/Copy';
import { Sym } from '../theme/Symbols';
import { SettingsRow } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';
import { IconButton, ActionButton, SurfaceButton, EmptyState } from '../theme/Controls';

class SetRow {
  icon: string = '';
  color: string = '';
  title: string = '';
  subtitle: string = '';
  url: string = '';
  keywords: string = '';
}

class SetGroup {
  title: string = '';
  rows: SetRow[] = [];
}

function row(icon: string, color: string, title: string, subtitle: string, url: string, keywords: string = ''): SetRow {
  const r = new SetRow();
  r.icon = icon;
  r.color = color;
  r.title = title;
  r.subtitle = subtitle;
  r.url = url;
  r.keywords = keywords;
  return r;
}

/**
 * 设置:和 iOS / 安卓同样四组(我的设备 / Agent / 外观与通用 / 数据与关于),浅灰底白卡片,
 * 每行一个彩色图标块。能搜;展开的折叠屏、平板上内容限宽居中。
 */
@Component
export struct SettingsPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @Prop showBack: boolean = false;
  onBack: () => void = () => {
    AppNavigation.back();
  };
  @State providerLine: string = '还没有 AI 服务商';
  @State query: string = '';
  @StorageProp('approvalTick') approvalTick: number = 0;
  private scroller: Scroller = new Scroller();
  private sectionOffsets: Map<string, number> = new Map();
  @State jumpError: string = '';

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

  private groups(): SetGroup[] {
    const device = new SetGroup();
    device.title = Copy.sectionDevice;
    device.rows = [
      row('keyboard', Tokens.secondary, 'SSH 终端', '原生加密连接，主机公钥验证与独立终端', 'pages/SSHTerminalPage'),
      row('computer', Tokens.secondary, '远程机器', '远程发任务、看进度、审批和停止', 'pages/FleetPage', 'Mac 远控'),
      row('dot_radiowaves_left_and_right', Tokens.secondary, '中继', '远程入口的地址和钥匙', 'pages/RelayPage'),
      row('phone', Tokens.secondary, '当身体', '让 iPhone、Mac 指挥这台鸿蒙', 'pages/BodyPage')
    ];
    const agent = new SetGroup();
    agent.title = Copy.sectionAgent;
    agent.rows = [
      row('globe_badge_message', Tokens.secondary, 'AI 服务商', this.providerLine, 'pages/ProviderListPage', '供应商 模型 钥匙'),
      row('square_grid_2x2', Tokens.secondary, '模型组', '一组模型，失败按顺序换', 'pages/ModelGroupsPage'),
      row('lock', Tokens.secondary, '权限与审批', '逐项确认、智能批准和全自动', 'pages/ApprovalPage'),
      row('wand_and_stars', Tokens.secondary, '技能', '名字和说明进对话，用到时再读全文', 'pages/SkillsPage', 'SKILL.md'),
      row('person', Tokens.secondary, '人格', 'SOUL.md：名字和性格', 'pages/SoulPage'),
      row('book', Tokens.secondary, '记忆', 'GLOBAL.md 与今日记忆', 'pages/MemoryPage'),
      row('envelope', Tokens.secondary, '邮箱账户', '加密保存账号，读信与受控发信', 'pages/MailAccountsPage'),
      row('keyboard', Tokens.secondary, '环境变量', '钥匙这类值只在执行时填进去', 'pages/EnvPage', '$$'),
      row('puzzle', Tokens.secondary, 'MCP', '远程 MCP 服务器，含智谱搜索预设', 'pages/McpPage', '搜索'),
      row('mic', Tokens.secondary, '录音纪要', '录音、转写、回放和生成纪要', 'pages/RecordingsPage'),
      row('clock', Tokens.secondary, '定时任务', '到点执行，App 关着也会补跑', 'pages/SchedulePage', '定时')
    ];
    const look = new SetGroup();
    look.title = Copy.sectionAppearance;
    look.rows = [
      row('lightbulb', Tokens.secondary, '外观', '跟随系统 / 浅色 / 深色、首页卡片', 'pages/AppearancePage',
        `${Copy.homeCardsTitle} 主动卡 深色 工具预览`),
      row('square_grid_2x2', Tokens.secondary, '系统集成', '小艺智能体、分享、推送与实况窗', 'pages/SystemIntegrationPage'),
      row('externaldrive', Tokens.secondary, '本机运行时', '语音、推送、后台', 'pages/RuntimePage', 'Push')
    ];
    const data = new SetGroup();
    data.title = Copy.sectionData;
    data.rows = [
      row('keyboard', Tokens.secondary, 'Linux 终端', '本机 Alpine 沙箱和工作区文件', 'pages/TerminalPage'),
      row('folder', Tokens.secondary, '沙箱文件', '附件和模型写的文件都在这里', 'pages/WorkspacePage', '附件'),
      row('bookshelf', Tokens.secondary, '第二大脑', '今日、影像、问、家人、资料', 'pages/BrainSpacePage'),
      row('book', Tokens.secondary, '手机收藏', '本机笔记和摘录', 'pages/CollectionsPage'),
      row('dot_radiowaves_left_and_right', Tokens.secondary, '跨端同步', '使用现有Mac同步协议，查看同步范围和状态', 'pages/SyncPage'),
      row('externaldrive', Tokens.secondary, '备份与恢复', '校验备份、保留旧数据并重启恢复', 'pages/BackupPage'),
      row('timer', Tokens.secondary, '用量', '本机对话用了多少 token', 'pages/UsagePage', 'token'),
      row('doc_text', Tokens.secondary, '本次更新', `版本 ${ReleaseCatalog.currentVersion}`, 'pages/ReleaseNotesPage', '版本')
    ];
    const q = this.query.trim().toLowerCase();
    const out: SetGroup[] = [];
    const all: SetGroup[] = [device, agent, look, data];
    for (let i = 0; i < all.length; i++) {
      const g = all[i];
      if (q.length > 0) {
        g.rows = g.rows.filter((r: SetRow) =>
          `${g.title} ${r.title} ${r.subtitle} ${r.keywords}`.toLowerCase().indexOf(q) >= 0);
      }
      if (g.rows.length > 0) {
        out.push(g);
      }
    }
    return out;
  }

  private jump(title: string): void {
    this.query = ''; this.jumpError = '';
    // Clearing a filter rebuilds group positions in the next frame.
    setTimeout(() => {
      const offset = this.sectionOffsets.get(title);
      if (offset !== undefined) this.scroller.scrollTo({ xOffset: 0, yOffset: offset });
      else this.jumpError = '分组暂未显示，请稍后重试';
    }, 0);
  }
  @Builder
  quickTile(title: string, value: () => string, icon: () => string, url: string) {
    SurfaceButton({ content: () => { this.quickTileContent(title, value, icon); } }).layoutWeight(1).backgroundColor(Tokens.reactive(this.tick, Tokens.card)).borderRadius(16)
      .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
      .accessibilityText(Tokens.reactive(this.tick, title + '，' + value())).onClick(() => AppNavigation.pushUrl({ url: url }))
  }
  @Builder
  quickSettings() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        this.quickTile('AI 服务商', () => this.providerLine, () => 'lock', 'pages/ProviderListPage')
        this.quickTile('模型组', () => providerStore.groups.find((group) => group.id === providerStore.activeGroupId)?.name ?? '未设置默认组', () => 'square_grid_2x2', 'pages/ModelGroupsPage')
      }.width('100%')
      Row({ space: 10 }) {
        this.quickTile('审批方式', () => this.approvalTick >= 0 ? SensitiveToolGate.modeTitle() : '', () => 'hand', 'pages/ApprovalPage')
        this.quickTile('外观', () => themeStore.mode === 'dark' ? '深色' : themeStore.mode === 'light' ? '浅色' : '跟随系统',
          () => themeStore.mode === 'dark' ? 'moon' : themeStore.mode === 'light' ? 'sun_max' : 'display', 'pages/AppearancePage')
      }.width('100%')
    }.width('100%').margin({ bottom: 18 })
  }

  @Builder
  quickTileContent(title: string, value: () => string, icon: () => string) {
      Column({ space: 8 }) {
        Sym({ name: Tokens.reactive(this.tick, icon()), dim: 22, color: Tokens.reactive(this.tick, Tokens.secondary) })
        Text(title).fontSize(16).fontWeight(FontWeight.Medium).fontColor(Tokens.reactive(this.tick, Tokens.text))
        Text(Tokens.reactive(this.tick, value())).fontSize(12).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).maxLines(2)
      }.padding(16).width('100%').constraintSize({ minHeight: 128 }).alignItems(HorizontalAlign.Start)

  }

  build() {
    Column() {
      if (this.showBack) {
        Row() {
          IconButton({ icon: 'chevron_left', label: '返回对话', onTap: () => this.onBack() })
        }
        .width('100%')
        .height(52)
        .padding({ left: 6 })
      }
      Scroll() {
        Row({ space: 8 }) {
          ForEach([Copy.sectionDevice, Copy.sectionAgent, Copy.sectionAppearance, Copy.sectionData], (title: string) => {
            ActionButton({ label: title, variant: 'quiet', fullWidth: false, onTap: () => this.jump(title) })
          }, (title: string) => title)
        }.padding({ left: 16, right: 16 })
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%')
      if (this.jumpError) Text(this.jumpError).fontSize(13).fontColor(Tokens.reactive(this.tick, Tokens.secondary)).padding(8)
      Scroll(this.scroller) {
        Column() {
          Text('设置')
            .fontSize(Tokens.largeTitle)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.reactive(this.tick, Tokens.text))
            .width('100%')
            .padding({ left: 4, top: this.showBack ? 0 : 12, bottom: 12 })
          if (!this.query) this.quickSettings()
          Row() {
            Sym({ name: 'magnifyingglass', dim: 15, color: Tokens.reactive(this.tick, Tokens.muted) })
            TextInput({ placeholder: Copy.settingsSearch, text: this.query })
              .onChange((value: string) => {
                this.query = value;
              })
              .layoutWeight(1)
              .height(44)
              .accessibilityText('搜索设置')
              .fontSize(15)
              .backgroundColor(Tokens.reactive(this.tick, Tokens.transparent))
              .fontColor(Tokens.reactive(this.tick, Tokens.text))
              .placeholderColor(Tokens.reactive(this.tick, Tokens.muted))
              .padding({ left: 6 })
            if (this.query) {
              IconButton({ icon: 'xmark', label: '清除搜索', onTap: () => { this.query = ''; } })
            }
          }
          .width('100%')
          .height(48)
          .padding({ left: 12, right: 6 })
          .backgroundColor(Tokens.reactive(this.tick, Tokens.dark ? Tokens.card : Tokens.surface2))
          .borderRadius(12)
          if (this.groups().length === 0) {
            Column({ space: 8 }) {
              Text('没有匹配的设置').fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.reactive(this.tick, Tokens.text))
              Text('换一个名称或关键词试试').fontSize(14).fontColor(Tokens.reactive(this.tick, Tokens.secondary))
            }.width('100%').padding({ top: 48, bottom: 48 })
          }
          ForEach(this.groups(), (group: SetGroup) => {
            Text(group.title)
              .fontSize(13)
              .fontColor(Tokens.reactive(this.tick, Tokens.secondary))
              .width('100%')
              .padding({ left: 16, top: 22, bottom: 7 })
              .onAreaChange((_old: Area, area: Area) => { this.sectionOffsets.set(group.title, Number(area.position.y)); })
            Column() {
              ForEach(group.rows, (r: SetRow, index: number) => {
                SettingsRow({
                  icon: r.icon,
                  color: r.color,
                  title: r.title,
                  subtitle: r.subtitle,
                  divider: index > 0,
                  onOpen: () => {
                    AppNavigation.pushUrl({ url: r.url });
                  }
                })
              }, (r: SetRow, index: number) => `${r.title}:${r.subtitle}:${index}`)
            }
            .width('100%')
            .backgroundColor(Tokens.reactive(this.tick, Tokens.card))
            .border({ width: Tokens.hairline, color: Tokens.reactive(this.tick, Tokens.separator) })
            .borderRadius(Tokens.groupRadius)
            .clip(true)
          }, (group: SetGroup) => `${group.title}|${group.rows.map((r: SetRow) => `${r.title}:${r.subtitle}`).join('|')}`)
          Text(`LeoBot 鸿蒙版 ${ReleaseCatalog.currentVersion}（${ReleaseCatalog.currentBuild}）`)
            .fontSize(12)
            .fontColor(Tokens.reactive(this.tick, Tokens.muted))
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 24 })
          Text(Copy.linuxRuntime)
            .fontSize(12)
            .fontColor(Tokens.reactive(this.tick, Tokens.muted))
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 4 })
        }
        .width('100%')
        .constraintSize({ maxWidth: Tokens.readable })
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 40 })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.reactive(this.tick, Tokens.grouped))
  }
}
