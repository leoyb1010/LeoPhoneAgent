import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import { ReplicaSync, ReplicaConflict } from '../sync/ReplicaSync';
import { normalizeReplicaRoot } from '../sync/SyncProtocol';
import { ActionButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct SyncPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State root: string = '';
  @State deviceId: string = '';
  @State token: string = '';
  @State busy: string = '';
  @State automatic: boolean = false;
  @State message: string = '';
  @State pending: ReplicaConflict[] = [];
  @State issues: string[] = [];
  @State detailsOpen: boolean = false;

  aboutToAppear(): void {
    try {
      const config = ReplicaSync.loadConfig(getContext(this) as common.UIAbilityContext);
      this.root = config.root; this.deviceId = config.deviceId; this.automatic = config.automatic === true;
      this.message = ReplicaSync.automaticStatus(getContext(this) as common.UIAbilityContext); this.refreshStatus();
    } catch (error) { this.message = `${error}`; }
  }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '跨端同步' })
      Scroll() {
        Column({ space: 18 }) {
          Text('设备之间，接着做').fontSize(27).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
          Text('与已配对 Mac 同步会话、附件、收藏、模型与工具配置、技能和记忆。未发送草稿在本机保管。')
            .fontSize(15).lineHeight(24).fontColor(Tokens.secondary).width('100%')
          Column({ space: 10 }) {
            Text('同步连接').fontSize(16).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
            this.field('Mac 直连地址', this.root, 'https://已配对的Mac地址', false, (value: string) => this.root = value)
            this.field('设备 ID', this.deviceId, '配对记录中的设备 ID', false, (value: string) => this.deviceId = value)
            this.field('同步授权', this.token, '粘贴新的授权令牌', true, (value: string) => this.token = value)
            ActionButton({ label: '保存连接', variant: 'secondary', busy: this.busy === 'save', isEnabled: !this.busy && this.token.trim().length >= 16, onTap: () => this.save() })
          }.padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(18)
          ActionButton({ label: '立即同步', icon: 'arrow_clockwise', busy: this.busy === 'sync', isEnabled: !this.busy, onTap: () => this.sync() })
          Column({ space: 10 }) {
            Row() {
              Column({ space: 4 }) {
                Text('前台自动同步').fontSize(15).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
                Text('前台空闲时每分钟核对，运行中或待审批时等待。').fontSize(13).lineHeight(20).fontColor(Tokens.secondary)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              Toggle({ type: ToggleType.Switch, isOn: this.automatic }).enabled(!this.busy).onChange((value: boolean) => this.setAutomatic(value))
            }.width('100%')
          }.padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(18)
          if (this.message) {
            Text(this.message).fontSize(14).lineHeight(22).fontColor(Tokens.text).width('100%')
              .padding(16).backgroundColor(Tokens.surface).borderRadius(14)
          }
          if (this.pending.length > 0) {
            Text(`有 ${this.pending.length} 项本机变更需要处理`).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
            ForEach(this.pending, (row: ReplicaConflict) => {
              Column({ space: 10 }) {
                Text(row.title).fontSize(15).fontWeight(FontWeight.Medium).fontColor(Tokens.text).maxLines(2).width('100%')
                Text(row.reason).fontSize(13).lineHeight(20).fontColor(Tokens.secondary).width('100%')
                ActionButton({ label: '保留本机并提交', variant: 'secondary', busy: this.busy === row.key, isEnabled: !this.busy, onTap: () => this.resolve(row.key, false) })
                ActionButton({ label: '使用已收到的远端版本', variant: 'quiet', isEnabled: !this.busy && row.hasRemote, onTap: () => this.resolve(row.key, true) })
              }.padding(16).width('100%').backgroundColor(Tokens.card).borderRadius(16).border({ width: Tokens.hairline, color: Tokens.separator })
            }, (row: ReplicaConflict) => row.key)
          }
          if (this.issues.length > 0) {
            ActionButton({ label: this.detailsOpen ? '收起同步记录' : `查看 ${this.issues.length} 条同步记录`, variant: 'quiet', onTap: () => this.detailsOpen = !this.detailsOpen })
            if (this.detailsOpen) {
              ForEach(this.issues, (issue: string) => {
                Text(issue).fontSize(13).lineHeight(20).fontColor(Tokens.warn).copyOption(CopyOptions.LocalDevice).width('100%')
              }, (issue: string, index: number) => `${index}|${issue}`)
            }
          }
          ActionButton({ label: '重新核对全部记录', variant: 'quiet', isEnabled: !this.busy, onTap: () => {
            try { ReplicaSync.resetCursor(getContext(this) as common.UIAbilityContext); this.message = '已准备重新核对，点击立即同步继续'; }
            catch (error) { this.message = `${error}`; }
          } })
        }.padding(Tokens.pagePad).width('100%').constraintSize({ maxWidth: 704 })
      }.layoutWeight(1).width('100%').align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  @Builder
  field(label: string, value: string, placeholder: string, password: boolean, changed: (value: string) => void) {
    Column({ space: 6 }) {
      Text(label).fontSize(13).fontColor(Tokens.secondary).width('100%')
      TextInput({ text: value, placeholder: placeholder }).type(password ? InputType.Password : InputType.Normal).onChange(changed)
        .height(48).fontSize(14).fontColor(Tokens.text).backgroundColor(Tokens.surface).borderRadius(12)
    }.width('100%')
  }
  private refreshStatus(): void {
    const context = getContext(this) as common.UIAbilityContext; this.pending = ReplicaSync.pending(context); this.issues = ReplicaSync.issues(context);
  }
  private async save(): Promise<void> {
    this.busy = 'save';
    try {
      await ReplicaSync.saveConfig(getContext(this) as common.UIAbilityContext, this.root, this.deviceId, this.token);
      this.token = ''; this.automatic = ReplicaSync.loadConfig(getContext(this) as common.UIAbilityContext).automatic; this.message = '同步连接已保存';
    } catch (error) { this.message = `${error}`; }
    finally { this.busy = ''; }
  }
  private async sync(): Promise<void> {
    if (this.busy) return; this.busy = 'sync';
    try {
      const context = getContext(this) as common.UIAbilityContext; const config = ReplicaSync.loadConfig(context);
      if (this.token.trim()) { await ReplicaSync.saveConfig(context, this.root, this.deviceId, this.token); this.token = ''; }
      else if (config.root !== normalizeReplicaRoot(this.root) || config.deviceId !== this.deviceId.trim()) throw new Error('连接已修改，请先保存目标与授权');
      const result = await ReplicaSync.run(context);
      this.message = `收到 ${result.received} 条，发出 ${result.sent} 条` + (result.waiting ? `，${result.waiting} 项待处理` : '，本轮核对完成') + (result.retained ? `，另有 ${result.retained} 条扩展或异常记录` : '');
    } catch (error) { this.message = `${error}`; }
    finally { this.busy = ''; this.refreshStatus(); }
  }
  private async resolve(key: string, remote: boolean): Promise<void> {
    if (this.busy) return; this.busy = key;
    try {
      const context = getContext(this) as common.UIAbilityContext; await ReplicaSync.resolve(context, key, remote);
      if (!remote) await ReplicaSync.run(context);
      this.message = remote ? '已应用收到的远端版本' : '本机选择已提交';
    } catch (error) { this.message = `${error}`; }
    finally { this.busy = ''; this.refreshStatus(); }
  }
  private async setAutomatic(value: boolean): Promise<void> {
    if (value === this.automatic) return;
    try {
      const context = getContext(this) as common.UIAbilityContext; const config = ReplicaSync.loadConfig(context);
      if (config.root !== normalizeReplicaRoot(this.root) || config.deviceId !== this.deviceId.trim()) throw new Error('请先保存当前同步连接');
      await ReplicaSync.setAutomatic(context, value); this.automatic = value;
    } catch (error) {
      try { this.automatic = ReplicaSync.loadConfig(getContext(this) as common.UIAbilityContext).automatic; } catch (_readError) { this.automatic = false; }
      this.message = `${error}`;
    }
  }
}
