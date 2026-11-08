import { common } from '@kit.AbilityKit';
import { ChatRuns, textLines } from '../local/ChatRun';
import { ChatItem, chatItems } from '../local/AgentText';
import { WorkspaceStore, WorkspaceFile } from '../store/WorkspaceStore';
import { ApprovalReceipt, ChatInteractionStore } from '../store/ChatInteractionStore';
import { AppNavigation } from '../navigation/AppNavigation';
import { ActionButton, EmptyState, IconButton, ListRow, SectionCard } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

/** Read-only companion. All mutations remain in the existing workspace/approval user paths. */
@Component
export struct ChatInspector {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('chatTick') @Watch('refresh') chatTick: number = 0;
  @StorageProp('interactionTick') @Watch('refresh') interactionTick: number = 0;
  @Prop @Watch('refresh') sessionId: string = '';
  @State files: WorkspaceFile[] = [];
  @State tools: ChatItem[] = [];
  @State receipts: ApprovalReceipt[] = [];
  @State pending: boolean = false;
  @State turnAt: number = 0;
  @State error: string = '';
  @State selectedTool: number = -1;
  onClose: () => void = () => {};
  aboutToAppear(): void { this.refresh(); }
  refresh(): void {
    const context = getContext(this) as common.UIAbilityContext;
    try { this.files = WorkspaceStore.list(context); this.error = ''; }
    catch (_error) { this.error = '工作区读取失败，文件未改动'; }
    if (!this.sessionId) { this.tools = []; this.receipts = []; this.pending = false; this.turnAt = 0; return; }
    const run = ChatRuns.open(context, this.sessionId);
    const latest = run.lines.filter((line) => line.role === 'user');
    this.turnAt = latest.length ? latest[latest.length - 1].at : 0;
    const all = chatItems(textLines(run.lines), run.active, run.lines.map((_line, index: number) => index));
    this.tools = all.filter((row: ChatItem) => row.kind === 'tool');
    this.pending = run.askWrite;
    this.receipts = ChatInteractionStore.forSession(this.sessionId);
  }
  @Builder
  fileRows(changed: boolean) {
    ForEach(this.files.filter((file: WorkspaceFile) => !changed || (this.turnAt > 0 && file.modified * 1000 >= this.turnAt)), (file: WorkspaceFile) => {
      ListRow({ icon: file.directory ? 'folder' : 'doc_text', title: file.name,
        subtitle: file.directory ? '文件夹' : `${file.size} 字节`, onOpen: () => {
          AppNavigation.pushUrl({ url: 'pages/WorkspacePage', params: { path: file.path, directory: file.directory } });
        } })
    }, (file: WorkspaceFile) => `${file.path}|${file.size}|${file.modified}|${file.directory}`)
  }
  build() {
    Column() {
      Row() {
        Text('右栏').fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).layoutWeight(1)
        IconButton({ icon: 'xmark', label: '关闭右栏', onTap: this.onClose })
      }.width('100%').padding({ left: 16, right: 6 })
      Scroll() {
        Column({ space: 14 }) {
          Text('本轮文件改动').fontSize(14).fontColor(Tokens.secondary).width('100%')
          Text('按当前轮次开始时间筛选工作区文件；不推断工具未返回的改动。').fontSize(12).fontColor(Tokens.muted)
          SectionCard() { this.fileRows(true) }
          if (!this.files.some((file: WorkspaceFile) => this.turnAt > 0 && file.modified * 1000 >= this.turnAt)) {
            Text('暂无本轮文件变更').fontSize(13).fontColor(Tokens.muted)
          }
          Text('工作区文件').fontSize(14).fontColor(Tokens.secondary).width('100%')
          if (this.error) ActionButton({ label: this.error + '，重试', variant: 'secondary', onTap: () => this.refresh() })
          else if (!this.files.length) EmptyState({ icon: 'folder', title: '工作区为空' })
          else SectionCard() { this.fileRows(false) }
          Text('工具调用详情').fontSize(14).fontColor(Tokens.secondary).width('100%')
          ForEach(this.tools, (tool: ChatItem) => {
            SectionCard() {
              ListRow({ icon: 'wand_and_stars', title: tool.title || tool.name, subtitle: tool.status,
                trailing: this.selectedTool === tool.index ? 'chevron_up' : 'chevron_down',
                onOpen: () => { this.selectedTool = this.selectedTool === tool.index ? -1 : tool.index; } })
              if (this.selectedTool === tool.index) Text(tool.text).copyOption(CopyOptions.LocalDevice)
                .fontSize(13).fontColor(Tokens.text).padding(12).width('100%')
            }
          }, (tool: ChatItem) => `${tool.index}|${tool.name}|${tool.title}|${tool.status}|${tool.text}`)
          if (!this.tools.length) Text('此会话暂无工具调用').fontSize(13).fontColor(Tokens.muted)
          Text('审批记录').fontSize(14).fontColor(Tokens.secondary).width('100%')
          if (this.pending) Text('有操作等待确认，请在对话内查看完整审批内容。').fontSize(13).fontColor(Tokens.warn)
          ForEach(this.receipts, (row: ApprovalReceipt) => {
            Text(`${new Date(row.at).toLocaleTimeString()} · ${row.decision}`).fontSize(13).fontColor(Tokens.text).width('100%')
          }, (row: ApprovalReceipt) => `${row.at}|${row.decision}`)
          Text('仅展示本次启动中你在此会话完成的审批操作，不代表工具执行成功。').fontSize(12).fontColor(Tokens.muted)
        }.padding(14).width('100%')
      }.layoutWeight(1).width('100%')
    }.height('100%').backgroundColor(Tokens.grouped)
  }
}
