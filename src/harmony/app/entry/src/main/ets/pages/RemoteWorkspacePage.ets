import { AppNavigation } from '../navigation/AppNavigation';
import { ActionButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';

import { image } from '@kit.ImageKit';
import { HarnessClient } from '../net/HarnessClient';
import { gatewayStore } from '../store/GatewayStore';
import { RemoteCapabilities, RemoteModel } from '../remote/RemoteModels';
import { RemoteWorkspaceLaunch } from '../remote/RemoteWorkspaceLaunch';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct RemoteWorkspacePage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State capabilities: RemoteCapabilities = new RemoteCapabilities();
  @State models: RemoteModel[] = [];
  @State snapshot: image.PixelMap | null = null;
  @State query: string = '';
  @State title: string = '';
  @State following: boolean = false;
  @State message: string = '';
  @State busy: boolean = false;
  @State creatingAutomation: boolean = false;
  @State files: Record<string, Object>[] = [];
  @State checkpoints: Record<string, Object>[] = [];
  @State diffText: string = '';
  @State automations: Record<string, Object>[] = [];
  @State automationName: string = '';
  @State automationPrompt: string = '';
  @State automationCron: string = '0 9 * * *';
  private client: HarnessClient | null = null;
  private sessionId: string = '';
  private active: boolean = false;

  aboutToAppear(): void {
    this.active = true;
    this.sessionId = RemoteWorkspaceLaunch.sessionId;
    this.load();
  }
  aboutToDisappear(): void { this.active = false; this.snapshot?.release(); this.snapshot = null; }

  private async load(): Promise<void> {
    this.busy = true;
    try {
      await gatewayStore.ensureLoaded(getContext(this) as common.UIAbilityContext);
      const client = new HarnessClient(gatewayStore.apiRoot, RemoteWorkspaceLaunch.machine, gatewayStore.key);
      this.client = client;
      const caps = await client.capabilities();
      if (!this.active) { return; }
      this.capabilities = caps;
      if (this.sessionId) {
        const row = await client.session(this.sessionId);
        if (!this.active) { return; }
        this.title = `${row['title'] ?? ''}`;
        this.following = row['following'] === true;
      }
      if (caps.has('models')) {
        const models = await client.models();
        if (this.active) { this.models = models; }
      }
      if (caps.has('automations')) {
        const automations = await client.automations();
        if (this.active) { this.automations = automations; }
      }
    } catch (err) { if (this.active) { this.message = `${err}`; } }
    finally { this.busy = false; }
  }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '远程工作区' })
      Scroll() {
        Column({ space: 16 }) {
          Text(RemoteWorkspaceLaunch.machine).fontSize(22).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
          if (this.message) { Text(this.message).fontSize(14).fontColor(Tokens.warn).copyOption(CopyOptions.InApp) }
          if (this.busy) { LoadingProgress().width(28).height(28) }
          ActionButton({ label: '刷新', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.load(); } })
          if (this.sessionId) {
            if (this.capabilities.has('rename')) {
              TextInput({ text: this.title, placeholder: '任务标题' }).onChange((value: string) => { this.title = value; })
              ActionButton({ label: '保存标题', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.rename(); } })
            }
            if (this.capabilities.has('follow')) {
              Row({ space: 12 }) {
                Text('关注任务通知').fontColor(Tokens.text)
                Toggle({ type: ToggleType.Switch, isOn: this.following }).enabled(!this.busy)
                  .onChange((value: boolean) => { this.follow(value); })
              }
            }
            if (this.capabilities.has('compact')) {
              ActionButton({ label: '压缩当前上下文', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.compact(); } })
            }
            if (this.capabilities.has('models') && this.capabilities.has('model_switch')) {
              Divider()
              Text('切换远程模型').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
              TextInput({ text: this.query, placeholder: '搜索模型 ID 或服务商' })
                .onChange((value: string) => { this.query = value; })
              ForEach(this.models.filter((row: RemoteModel) =>
                `${row.providerName} ${row.model}`.toLowerCase().includes(this.query.toLowerCase())), (row: RemoteModel) => {
                Column({ space: 6 }) {
                  ActionButton({ label: row.model, variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.changeModel(row, ''); } })
                  Text(row.providerName).fontSize(12).fontColor(Tokens.muted)
                  if (this.capabilities.has('effort')) {
                    Flex({ wrap: FlexWrap.Wrap }) {
                      ForEach(row.efforts, (effort: string) => {
                        ActionButton({ label: effort, variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.changeModel(row, effort); } }).margin(4)
                      })
                    }
                  }
                }.alignItems(HorizontalAlign.Start).width('100%')
              }, (row: RemoteModel) => row.provider + ':' + row.model)
            }
            if (this.capabilities.server === 'leophoneagent') {
              Divider()
              Text('工作区改动与检查点').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
              ActionButton({ label: '读取文件改动', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.loadChanges(); } })
              ForEach(this.files, (file: Record<string, Object>) => {
                Row({ space: 8 }) {
                  Text(`${file['status'] ?? ''} ${file['path'] ?? ''}`).fontSize(13).fontColor(Tokens.text).layoutWeight(1)
                  ActionButton({ label: '差异', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.showDiff(`${file['path'] ?? ''}`); } })
                  ActionButton({ label: '还原', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.confirmRevert('', [`${file['path'] ?? ''}`]); } })
                }
              })
              ForEach(this.checkpoints, (point: Record<string, Object>) => {
                Row({ space: 8 }) {
                  Text(`${point['label'] ?? point['id'] ?? ''}`).fontSize(13).fontColor(Tokens.text).layoutWeight(1)
                  ActionButton({ label: '恢复到此处', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.confirmRevert(`${point['id'] ?? ''}`, []); } })
                }
              })
              if (this.diffText) {
                Text(this.diffText).fontSize(12).fontFamily('monospace').fontColor(Tokens.text).copyOption(CopyOptions.InApp)
              }
            }
          } else {
            Text('发送第一条任务后可在这里设置模型、上下文和工作区改动。').fontSize(14).fontColor(Tokens.muted)
          }
          if (this.capabilities.has('screen_session')) {
            ActionButton({ label: '视频看屏与操控', variant: 'secondary', fullWidth: false, busy: false, isEnabled: true, onTap: () => { AppNavigation.pushUrl({ url: 'pages/ScreenSessionPage' }); } })
          }
          if (this.capabilities.has('screen_snapshot')) {
            Divider()
            Text('Mac 屏幕').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
            ActionButton({ label: '获取屏幕截图', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.loadSnapshot(); } })
            if (this.snapshot) { Image(this.snapshot).width('100%').objectFit(ImageFit.Contain) }
          }
          if (this.capabilities.has('automations')) {
            Divider()
            Text('Mac 定时任务').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
            ForEach(this.automations, (row: Record<string, Object>) => {
              Column({ space: 8 }) {
                Text(`${row['name'] ?? ''}`).fontSize(17).fontColor(Tokens.text)
                Text(`${row['prompt'] ?? ''}`).fontSize(13).fontColor(Tokens.secondary)
                Text(this.scheduleLabel(row))
                  .fontSize(12).fontColor(Tokens.muted)
                Flex({ wrap: FlexWrap.Wrap }) {
                  ActionButton({ label: row['enabled'] === true ? '暂停' : '启用', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.automationAction(row, 'enabled'); } })
                  ActionButton({ label: '立即执行', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => {
                    AlertDialog.show({ title: '立即执行远程任务', message: `${row['prompt'] ?? ''}`,
                      confirm: { value: '执行', action: () => { this.automationAction(row, 'run'); } }, cancel: () => {} });
                  } })
                  ActionButton({ label: '删除', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => {
                    AlertDialog.show({ title: '删除定时任务', message: `${row['name'] ?? ''}`,
                      confirm: { value: '删除', action: () => { this.automationAction(row, 'delete'); } }, cancel: () => {} });
                  } })
                }
              }.alignItems(HorizontalAlign.Start).padding(12).backgroundColor(Tokens.card).borderRadius(12)
            })
            TextInput({ text: this.automationName, placeholder: '新任务名称' }).onChange((value: string) => { this.automationName = value; })
            TextArea({ text: this.automationPrompt, placeholder: '让这台 Mac 做什么' }).height(100)
              .onChange((value: string) => { this.automationPrompt = value; })
            TextInput({ text: this.automationCron, placeholder: '五段 Cron，按 Mac 的本地时区执行' })
              .onChange((value: string) => { this.automationCron = value; })
            ActionButton({ label: '创建定时任务', variant: 'primary', fullWidth: true, busy: this.creatingAutomation, isEnabled: !this.busy && this.automationPrompt.trim().length > 0, onTap: () => { this.createAutomation(); } })
          }
        }.width('100%').constraintSize({ maxWidth: 720 }).alignItems(HorizontalAlign.Start).padding({ left: 24, right: 24, top: 24, bottom: 40 })
      }.layoutWeight(1)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  private scheduleLabel(row: Record<string, Object>): string {
    const schedule = row['schedule'] as Record<string, Object> | undefined;
    return `${schedule ? schedule['human'] ?? '' : ''} · ${row['time_zone'] ?? ''}`;
  }

  private async loadSnapshot(): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try {
      const bytes = await this.client.screenSnapshot();
      const source = image.createImageSource(bytes);
      try {
        const pixel = await source.createPixelMap();
        if (!this.active) { pixel.release(); return; }
        this.snapshot?.release();
        this.snapshot = pixel;
      } finally { source.release(); }
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }

  private async rename(): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try { this.title = await this.client.rename(this.sessionId, this.title); this.message = '标题已保存到 Mac'; }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async follow(value: boolean): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try { this.following = await this.client.follow(this.sessionId, value); }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async compact(): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try { await this.client.compact(this.sessionId); this.message = 'Mac 已接受压缩请求'; }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async changeModel(row: RemoteModel, effort: string): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try {
      const reply = await this.client.setModel(this.sessionId, row.provider, row.model, effort) as Record<string, Object>;
      const actual = reply['model'] as Record<string, Object> | undefined;
      this.message = actual ? `当前模型 ${actual['model'] ?? ''} · ${actual['effort'] ?? ''}` : 'Mac 已接受切换请求';
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async loadChanges(): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try {
      const reply = await this.client.changes(this.sessionId);
      this.files = Array.isArray(reply['files']) ? reply['files'] as Record<string, Object>[] : [];
      this.checkpoints = Array.isArray(reply['checkpoints']) ? reply['checkpoints'] as Record<string, Object>[] : [];
      this.message = reply['is_repo'] === false ? '这个工作区尚未建立 Git 仓库' : `共 ${this.files.length} 个文件改动`;
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async showDiff(path: string): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try { this.diffText = await this.client.diff(this.sessionId, path); }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private confirmRevert(checkpoint: string, paths: string[]): void {
    AlertDialog.show({ title: '还原 Mac 上的文件', message: '这会覆盖所选文件的当前改动。运行中的任务需要先停止。',
      confirm: { value: '确认还原', action: () => { this.revert(checkpoint, paths); } }, cancel: () => {} });
  }
  private async revert(checkpoint: string, paths: string[]): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try { const reverted = await this.client.revert(this.sessionId, checkpoint, paths); this.message = `已还原 ${reverted.length} 个文件`; }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async automationAction(row: Record<string, Object>, action: string): Promise<void> {
    if (!this.client) { return; }
    this.busy = true;
    try {
      await this.client.changeAutomation(`${row['id'] ?? ''}`, action, row['enabled'] !== true);
      this.automations = await this.client.automations();
      this.message = action === 'run' ? 'Mac 已接受执行请求' : '已保存';
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async createAutomation(): Promise<void> {
    if (!this.client) { return; }
    this.busy = true; this.creatingAutomation = true;
    try {
      await this.client.createAutomation(this.automationName, this.automationPrompt, this.automationCron);
      this.automations = await this.client.automations();
      this.automationName = ''; this.automationPrompt = ''; this.message = '定时任务已创建';
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; this.creatingAutomation = false; }
  }
}
