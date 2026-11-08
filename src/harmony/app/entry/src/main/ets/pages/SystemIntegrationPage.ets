import { ActionButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { AgentSettings } from '../agentextension/AgentSettings';
import { PushRegistrar } from '../push/PushRegistrar';
import { ShareInbox } from '../shareextension/ShareInbox';
import { TaskLiveView } from '../live/TaskLiveView';
import { NavBar, StatusPill } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct SystemIntegrationPage {
  @State agentEnabled: boolean = false;
  @State push: string = '';
  @State message: string = '';
  @State shareText: string = '';
  @State shareId: string = '';
  @State shareFiles: string[] = [];
  @State busy: boolean = false;
  @State loading: boolean = true;
  @State savingAgent: boolean = false;
  @State clearingShare: boolean = false;
  @State failed: boolean = false;

  aboutToAppear(): void {
    this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      this.agentEnabled = await AgentSettings.enabled(ctx);
      this.push = PushRegistrar.line();
      const shared = await ShareInbox.peek(ctx);
      this.shareText = shared?.text ?? ''; this.shareId = shared?.id ?? '';
      this.shareFiles = shared?.files ?? [];
    } catch (_err) {
      this.message = '读取系统集成状态失败，请重试'; this.failed = true;
    } finally { this.loading = false; }
  }

  build() {
    Column() {
      NavBar({ title: '系统集成' })
      Scroll() {
        Column({ space: 20 }) {
          Column({ space: 8 }) {
            Text('连接系统入口').fontSize(28).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
            Text('管理系统智能体、任务通知和其他应用送来的分享。每项授权独立保存。')
              .fontSize(14).fontColor(Tokens.secondary).lineHeight(22).width('100%')
          }.width('100%').alignItems(HorizontalAlign.Start)
          Column({ space: 14 }) {
            Row({ space: 12 }) {
              Text('系统智能体').fontSize(19).fontWeight(FontWeight.Bold).fontColor(Tokens.text).layoutWeight(1)
              StatusPill({ label: this.agentEnabled ? '已授权' : '需授权', dot: this.agentEnabled ? Tokens.online : Tokens.muted })
            }.width('100%')
            Text('允许系统智能体使用本机配置的模型处理请求。按无人值守权限执行，结果返回给发起方。')
              .fontSize(14).fontColor(Tokens.secondary).lineHeight(22).width('100%')
            Row({ space: 16 }) {
              Text(this.savingAgent ? '正在保存授权…' : '允许系统调用').fontSize(15).fontColor(Tokens.text).layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: this.agentEnabled })
                .enabled(!this.loading && !this.savingAgent).accessibilityText('允许系统智能体调用')
                .onChange((value: boolean) => { this.saveAgent(value); })
            }.width('100%')
            Text('小艺和 A2A 的开放资格、发现与调用需在支持的真机上核验。')
              .fontSize(12).fontColor(Tokens.muted).lineHeight(19).width('100%')
          }.width('100%').padding(20).backgroundColor(Tokens.card).borderRadius(20).alignItems(HorizontalAlign.Start)
          Column({ space: 14 }) {
            Text('任务通知').fontSize(19).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
            Text(this.push || '正在读取登记状态…').fontSize(14).fontColor(Tokens.secondary).lineHeight(22).width('100%')
            ActionButton({ label: '授权通知并登记推送', variant: 'primary', fullWidth: true, busy: this.busy, isEnabled: !this.busy && !this.loading, onTap: () => { this.registerPush(); } })
            Text('通知携带任务定位信息，打开后重新验证机器与会话。任务回执由已连接的中继发送。')
              .fontSize(12).fontColor(Tokens.muted).lineHeight(19).width('100%')
            if (TaskLiveView.error) { Text(TaskLiveView.error).fontColor(Tokens.warn).fontSize(13).width('100%') }
          }.width('100%').padding(20).backgroundColor(Tokens.card).borderRadius(20).alignItems(HorizontalAlign.Start)
          Column({ space: 14 }) {
            Row() {
              Text('待发送的分享').fontSize(19).fontWeight(FontWeight.Bold).fontColor(Tokens.text).layoutWeight(1)
              if (this.shareFiles.length > 0) { Text(this.shareFiles.length + ' 个文件').fontSize(12).fontColor(Tokens.muted) }
            }.width('100%')
            if (this.shareText || this.shareFiles.length > 0) {
              if (this.shareText) { Text(this.shareText.slice(0, 4000)).fontSize(14).fontColor(Tokens.text).lineHeight(22).copyOption(CopyOptions.InApp).width('100%') }
              ForEach(this.shareFiles, (name: string) => { Text(name).fontSize(13).fontColor(Tokens.secondary).width('100%') })
              Flex({ wrap: FlexWrap.Wrap }) {
                ActionButton({ label: '打开聊天草稿', variant: 'secondary', fullWidth: false, isEnabled: !this.clearingShare, onTap: () => { router.pushUrl({ url: 'pages/LocalChatPage' }); } }).margin({ right: 8, bottom: 8 })
                ActionButton({ label: '清除待发送内容', variant: 'danger', fullWidth: false, busy: this.clearingShare, isEnabled: !this.clearingShare, onTap: () => { this.clearShare(); } })
              }.width('100%')
            } else {
              Text('暂无待发送内容').fontSize(15).fontColor(Tokens.text)
              Text('从其他应用分享文字、链接和文件到 LeoBot，确认后发送。').fontSize(14).fontColor(Tokens.secondary).lineHeight(22).width('100%')
            }
          }.width('100%').padding(20).backgroundColor(Tokens.card).borderRadius(20).alignItems(HorizontalAlign.Start)
          if (this.message) {
            Text(this.message).fontSize(14).fontColor(this.failed ? Tokens.warn : Tokens.online).lineHeight(22).width('100%').copyOption(CopyOptions.InApp)
          }
        }.width('100%').constraintSize({ maxWidth: 600 }).alignItems(HorizontalAlign.Start).padding({ left: 20, right: 20, top: 24, bottom: 40 })
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)
  }

  private async saveAgent(value: boolean): Promise<void> {
    if (this.savingAgent || this.loading) { return; }
    const previous = this.agentEnabled; this.agentEnabled = value; this.savingAgent = true; this.message = '';
    try {
      await AgentSettings.setEnabled(getContext(this), value);
      this.failed = false; this.message = value ? '系统智能体授权已开启' : '系统智能体授权已关闭';
    } catch (_error) { this.agentEnabled = previous; this.failed = true; this.message = '授权保存失败，请重试'; }
    finally { this.savingAgent = false; }
  }

  private async clearShare(): Promise<void> {
    if (this.clearingShare) { return; }
    const id = this.shareId; this.clearingShare = true; this.message = '';
    try { await ShareInbox.clear(getContext(this), id); await this.refresh(); }
    catch (_error) { this.failed = true; this.message = '清除失败，请重试'; }
    finally { this.clearingShare = false; }
  }

  private async registerPush(): Promise<void> {
    this.busy = true; this.message = '';
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      await notificationManager.requestEnableNotification(ctx);
      await PushRegistrar.bind(ctx);
      this.push = PushRegistrar.line();
    } catch (_err) {
      this.failed = true; this.message = '通知授权或推送登记失败，请检查系统设置';
    } finally {
      this.busy = false;
    }
  }
}
