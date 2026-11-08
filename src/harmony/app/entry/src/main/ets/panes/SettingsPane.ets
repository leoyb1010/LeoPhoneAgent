import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { providerStore } from '../store/ProviderStore';
import { Copy } from '../theme/Copy';
import { Sym } from '../theme/Symbols';
import { SettingsRow } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';
import { IconButton } from '../theme/Controls';

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
    router.back();
  };
  @State providerLine: string = '还没有 AI 服务商';
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

  private groups(): SetGroup[] {
    const device = new SetGroup();
    device.title = Copy.sectionDevice;
    device.rows = [
      row('keyboard', '#267B6D', 'SSH 终端', '原生加密连接，主机公钥验证与独立终端', 'pages/SSHTerminalPage'),
      row('computer', '#30B0C7', '远程机器', '远程发任务、看进度、审批和停止', 'pages/FleetPage', 'Mac 远控'),
      row('dot_radiowaves_left_and_right', '#30B0C7', '中继', '远程入口的地址和钥匙', 'pages/RelayPage'),
      row('phone', '#30B0C7', '当身体', '让 iPhone、Mac 指挥这台鸿蒙', 'pages/BodyPage')
    ];
    const agent = new SetGroup();
    agent.title = Copy.sectionAgent;
    agent.rows = [
      row('globe_badge_message', '#007AFF', 'AI 服务商', this.providerLine, 'pages/ProviderListPage', '供应商 模型 钥匙'),
      row('square_grid_2x2', '#007AFF', '模型组', '一组模型，失败按顺序换', 'pages/ModelGroupsPage'),
      row('lock', '#267B6D', '权限与审批', '逐项确认、智能批准和全自动', 'pages/ApprovalPage'),
      row('wand_and_stars', '#5856D6', '技能', '名字和说明进对话，用到时再读全文', 'pages/SkillsPage', 'SKILL.md'),
      row('person', '#2E8B8B', '人格', 'SOUL.md：名字和性格', 'pages/SoulPage'),
      row('book', '#5856D6', '记忆', 'GLOBAL.md 与今日记忆', 'pages/MemoryPage'),
      row('envelope', '#34C759', '邮箱账户', '加密保存账号，读信与受控发信', 'pages/MailAccountsPage'),
      row('keyboard', '#34C759', '环境变量', '钥匙这类值只在执行时填进去', 'pages/EnvPage', '$$'),
      row('puzzle', '#34C759', 'MCP', '远程 MCP 服务器，含智谱搜索预设', 'pages/McpPage', '搜索'),
      row('mic', '#FF9500', '录音纪要', '录音、转写、回放和生成纪要', 'pages/RecordingsPage'),
      row('clock', '#FF9500', '定时任务', '到点执行，App 关着也会补跑', 'pages/SchedulePage', '定时')
    ];
    const look = new SetGroup();
    look.title = Copy.sectionAppearance;
    look.rows = [
      row('lightbulb', '#5856D6', '外观', '跟随系统 / 浅色 / 深色、首页卡片', 'pages/AppearancePage',
        `${Copy.homeCardsTitle} 主动卡 深色 工具预览`),
      row('square_grid_2x2', '#30B0C7', '系统集成', '小艺智能体、分享、推送与实况窗', 'pages/SystemIntegrationPage'),
      row('externaldrive', '#8E8E93', '本机运行时', '语音、推送、后台', 'pages/RuntimePage', 'Push')
    ];
    const data = new SetGroup();
    data.title = Copy.sectionData;
    data.rows = [
      row('keyboard', '#34C759', 'Linux 终端', '本机 Alpine 沙箱和工作区文件', 'pages/TerminalPage'),
      row('folder', '#34C759', '沙箱文件', '附件和模型写的文件都在这里', 'pages/WorkspacePage', '附件'),
      row('bookshelf', '#FF9500', '第二大脑', '今日、影像、问、家人、资料', 'pages/BrainSpacePage'),
      row('book', '#FF9500', '手机收藏', '本机笔记和摘录', 'pages/CollectionsPage'),
      row('dot_radiowaves_left_and_right', '#30B0C7', '跨端同步', '使用现有Mac同步协议，查看同步范围和状态', 'pages/SyncPage'),
      row('externaldrive', '#8E8E93', '备份与恢复', '校验备份、保留旧数据并重启恢复', 'pages/BackupPage'),
      row('timer', '#007AFF', '用量', '本机对话用了多少 token', 'pages/UsagePage', 'token'),
      row('doc_text', '#8E8E93', '本次更新', `版本 ${ReleaseCatalog.currentVersion}`, 'pages/ReleaseNotesPage', '版本')
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
        Column() {
          Text('设置')
            .fontSize(Tokens.largeTitle)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text)
            .width('100%')
            .padding({ left: 4, top: this.showBack ? 0 : 12, bottom: 12 })
          Row() {
            Sym({ name: 'magnifyingglass', dim: 15, color: Tokens.muted })
            TextInput({ placeholder: Copy.settingsSearch, text: this.query })
              .onChange((value: string) => {
                this.query = value;
              })
              .layoutWeight(1)
              .height(44)
              .accessibilityText('搜索设置')
              .fontSize(15)
              .backgroundColor('#00000000')
              .fontColor(Tokens.text)
              .placeholderColor(Tokens.muted)
              .padding({ left: 6 })
            if (this.query) {
              IconButton({ icon: 'xmark', label: '清除搜索', onTap: () => { this.query = ''; } })
            }
          }
          .width('100%')
          .height(48)
          .padding({ left: 12, right: 6 })
          .backgroundColor(Tokens.dark ? Tokens.card : Tokens.surface2)
          .borderRadius(12)
          if (this.groups().length === 0) {
            Column({ space: 8 }) {
              Text('没有匹配的设置').fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
              Text('换一个名称或关键词试试').fontSize(14).fontColor(Tokens.secondary)
            }.width('100%').padding({ top: 48, bottom: 48 })
          }
          ForEach(this.groups(), (group: SetGroup) => {
            Text(group.title)
              .fontSize(13)
              .fontColor(Tokens.secondary)
              .width('100%')
              .padding({ left: 16, top: 22, bottom: 7 })
            Column() {
              ForEach(group.rows, (r: SetRow, index: number) => {
                SettingsRow({
                  icon: r.icon,
                  color: r.color,
                  title: r.title,
                  subtitle: r.subtitle,
                  divider: index > 0,
                  onOpen: () => {
                    router.pushUrl({ url: r.url });
                  }
                })
              }, (r: SetRow, index: number) => `${r.title}:${r.subtitle}:${index}`)
            }
            .width('100%')
            .backgroundColor(Tokens.card)
            .borderRadius(Tokens.groupRadius)
            .clip(true)
          }, (group: SetGroup) => `${group.title}|${group.rows.map((r: SetRow) => `${r.title}:${r.subtitle}`).join('|')}`)
          Text(`LeoBot 鸿蒙版 ${ReleaseCatalog.currentVersion}（${ReleaseCatalog.currentBuild}）`)
            .fontSize(12)
            .fontColor(Tokens.muted)
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 24 })
          Text(Copy.linuxRuntime)
            .fontSize(12)
            .fontColor(Tokens.muted)
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
    .backgroundColor(Tokens.grouped)
  }
}
