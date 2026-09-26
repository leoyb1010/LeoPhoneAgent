import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { Composer } from '../chat/Composer';
import { AssistantHead, NoticeRow, UserBubble } from '../chat/ChatViews';
import { MarkdownText } from '../theme/Markdown';
import { Sym } from '../theme/Symbols';
import { displayName } from '../net/Protocol';
import { ApprovalState, ChatLaunch, ChatLine, HarnessClient, HttpError } from '../net/HarnessClient';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { gatewayStore } from '../store/GatewayStore';
import { Tokens } from '../theme/Tokens';

const MAX_RECONNECTS = 8;

/** Mac 给的答法 → 按钮文字,和 iOS、安卓同一套。 */
function choiceLabel(choice: string): string {
  if (choice === 'once') {
    return '允许一次';
  }
  if (choice === 'session') {
    return '本次会话允许';
  }
  if (choice === 'always') {
    return '始终允许';
  }
  if (choice === 'deny') {
    return '拒绝';
  }
  return choice;
}

@Component
export struct ChatPane {
  @StorageProp('approvalTick') approvalTick: number = 0;
  @Prop machine: string = '';
  /** 手机上推进来的一页:左上角返回。 */
  @Prop showBack: boolean = false;
  /** 每次从列表打开都会变:同一台机器换 Agent、换任务也要重新接上(平板两栏时这一栏不会重建)。 */
  @Prop @Watch('onLaunch') launch: number = 0;
  @State lines: ChatLine[] = [];
  @State liveText: string = '';
  @State draft: string = '';
  @State status: string = '准备中';
  @State approval: ApprovalState = new ApprovalState();
  @State lastSeq: number = 0;
  private sessionId: string = '';
  private scroller: Scroller = new Scroller();
  private client: HarnessClient | null = null;
  private stream: http.HttpRequest | null = null;
  /** 正在流式输出的那段回答:字走 liveText 原地刷新,不每来几个字整个列表重排。 */
  private liveLine: ChatLine | null = null;
  private alive: boolean = false;
  private reconnects: number = 0;
  private reconnectTimer: number = -1;
  private approvalQueue: ApprovalState[] = [];
  /** 自己发出去、还没等到回显的话:Mac 的回显到了就不再显示第二遍。 */
  private pendingEcho: string[] = [];
  /** 这一轮已经收尾(完成、失败、停止):流随后正常关闭时不再重连,发下一条再接上。 */
  private ended: boolean = false;
  /** Mac 拒过这台设备的全自动(旧版 Mac 或中继认不出设备):这个任务里不再请求。 */
  private fullAutoRefused: boolean = false;

  aboutToAppear(): void {
    this.startSession();
  }

  aboutToDisappear(): void {
    this.teardown();
  }

  onLaunch(): void {
    this.teardown();
    this.lines = [];
    this.draft = '';
    this.approval = new ApprovalState();
    this.approvalQueue = [];
    this.pendingEcho = [];
    this.lastSeq = 0;
    this.sessionId = '';
    this.liveLine = null;
    this.liveText = '';
    this.ended = false;
    this.reconnects = 0;
    this.fullAutoRefused = false;
    this.startSession();
  }

  build() {
    Column() {
      Stack() {
        Column() {
          Text(this.machine.length > 0 ? displayName(this.machine) : '远程')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Row() {
            Column()
              .width(6)
              .height(6)
              .borderRadius(3)
              .backgroundColor(this.status === '需要审批' ? Tokens.warn : (this.badStatus() ? Tokens.danger : Tokens.online))
            Text(`${this.agentName()} · ${this.status}`)
              .fontSize(12)
              .fontColor(this.status === '需要审批' ? Tokens.warn : Tokens.secondary)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .margin({ left: 5 })
          }
          .margin({ top: 2 })
        }
        .padding({ left: 56, right: 56 })
        Row() {
          if (this.showBack) {
            Stack() {
              Sym({ name: 'chevron_left', dim: 20, color: Tokens.text })
            }
            .width(40)
            .height(40)
            .onClick(() => {
              router.back();
            })
          }
          Blank()
        }
        .width('100%')
      }
      .width('100%')
      .height(Tokens.chatBar)
      .padding({ left: 6, right: 8 })
      .border({ width: { bottom: Tokens.hairline }, color: Tokens.separator })

      if (this.machine.length === 0) {
        Column() {
          Sym({ name: 'computer', dim: 40, color: Tokens.muted })
          Text('选一台在线机器')
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
            .margin({ top: 12 })
          Text('左边点一台机器，就在这里指挥它。')
            .fontSize(14)
            .fontColor(Tokens.secondary)
            .margin({ top: 6 })
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .padding(24)
      } else {
        List({ scroller: this.scroller }) {
          ForEach(this.lines, (line: ChatLine, index: number) => {
            ListItem() {
              Column() {
                if (line.role === 'user') {
                  Row() {
                    Blank()
                    UserBubble({ text: line.text })
                  }
                  .width('100%')
                  .margin({ top: 12, bottom: 4 })
                } else if (line.role === 'assistant') {
                  if (index === 0 || this.lines[index - 1].role !== 'assistant') {
                    AssistantHead({ name: this.agentName() })
                      .margin({ top: 10 })
                  }
                  MarkdownText({ text: line === this.liveLine ? this.liveText : line.text })
                } else {
                  NoticeRow({ text: line.text })
                }
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              .constraintSize({ maxWidth: Tokens.readable })
            }
            .width('100%')
            // key 带上字:key 不变 ForEach 就不重画(流式输出被截断就是这么来的);在流的那段走 liveText
          }, (line: ChatLine, index: number) => `${index}|${line.role}|${line.text}`)
        }
        .layoutWeight(1)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
        .contentStartOffset(8)
        .contentEndOffset(16)
        .alignListItem(ListItemAlign.Center)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }

      if (this.machine.length > 0) {
        Column() {
          if (this.approval.id.length > 0) {
            Column() {
              Row() {
                Sym({ name: 'hand', dim: 15, color: Tokens.warn })
                Text(this.approvalQueue.length > 1 ? `需要审批 · 还有 ${this.approvalQueue.length - 1} 条` : '需要审批')
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(Tokens.text)
                  .margin({ left: 6 })
              }
              Text(this.approval.command)
                .fontSize(13)
                .lineHeight(19)
                .fontFamily('monospace')
                .fontColor(Tokens.secondary)
                .maxLines(4)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
                .padding(10)
                .backgroundColor(Tokens.chip)
                .borderRadius(10)
                .margin({ top: 8 })
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(this.approval.choices, (choice: string) => {
                  Text(choiceLabel(choice))
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(choice === 'deny' ? Tokens.text : '#FFFFFF')
                    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                    .backgroundColor(choice === 'deny' ? Tokens.chip : Tokens.accent)
                    .borderRadius(18)
                    .margin({ right: 8, top: 10 })
                    .onClick(() => {
                      this.answer(choice, false);
                    })
                }, (choice: string) => choice)
              }
              .width('100%')
              Text('拒绝并停止任务')
                .fontSize(13)
                .fontColor(Tokens.danger)
                .margin({ top: 10 })
                .onClick(() => {
                  this.answer('deny', true);
                })
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding(14)
            .backgroundColor(Tokens.card)
            .borderRadius(16)
            .border({ width: Tokens.hairline, color: Tokens.separator })
            .shadow({ radius: 12, color: Tokens.composerShadow, offsetY: 2 })
            .margin({ bottom: 8 })
          }
          Composer({
            draft: $draft,
            placeholder: `给 ${this.machine.length > 0 ? displayName(this.machine) : '远程机器'} 发任务`,
            running: this.status === '进行中',
            showApproval: ChatLaunch.harness === 'zcode',
            fullAuto: SensitiveToolGate.fullAuto && this.approvalTick >= 0,
            tools: false,
            showMic: false,
            onSend: () => {
              this.send();
            },
            onStop: () => {
              this.stop();
            },
            onApproval: () => {
              const ctx = getContext(this) as common.UIAbilityContext;
              SensitiveToolGate.setFullAuto(ctx, !SensitiveToolGate.fullAuto);
            }
          })
        }
        .width('100%')
        .constraintSize({ maxWidth: Tokens.readable + 24 })
        .padding({ left: 10, right: 10, top: 4, bottom: 10 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  private agentName(): string {
    return ChatLaunch.harness === 'zcode' || ChatLaunch.harness === 'minis' ? 'LeoPhoneAgent' :
      (ChatLaunch.harness === 'claude' ? 'Claude Code' : (ChatLaunch.harness === 'codex' ? 'Codex' :
        (ChatLaunch.harness.length > 0 ? ChatLaunch.harness : 'LeoPhoneAgent')));
  }

  private badStatus(): boolean {
    return this.status.indexOf('失败') >= 0 || this.status.indexOf('不对') >= 0 || this.status.indexOf('连不上') >= 0 ||
      this.status.indexOf('没送到') >= 0;
  }

  private startSession(): void {
    this.alive = true;
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.ensureLoaded(ctx).then(() => {
      if (!this.alive) {
        return;
      }
      if (!this.machine) {
        this.status = '选一台机器';
        return;
      }
      this.client = new HarnessClient(gatewayStore.apiRoot, this.machine, gatewayStore.key);
      // 选中的(或这台机器上次用的)任务就接着看,回放会补齐对话和还挂着的审批;没有就等第一条消息再建。
      // 原来每次点进来都在 Mac 上建一个空任务,iPhone 首页跟着多出一行「可继续」。
      const saved = ChatLaunch.sessions.get(ChatLaunch.key(this.machine, ChatLaunch.harness)) ?? '';
      if (saved.length > 0) {
        this.sessionId = saved;
        this.status = '接着这个任务';
        this.listen(0);
      } else {
        this.status = '发一条消息就开始';
      }
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private teardown(): void {
    this.alive = false;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.client = null;
  }

  private listen(after: number): void {
    if (!this.alive || !this.client || !this.sessionId) {
      return;
    }
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    // 换任务、重连时旧的流已经关掉;它迟到的回调不能再动现在这条(原来会把新流的引用清空、再多连一次)。
    const req = this.client.startEvents(this.sessionId, after, (obj: Record<string, Object>) => {
      if (this.stream === req) {
        this.onEvent(obj);
      }
    }, (message: string, final: boolean) => {
      if (this.stream === req) {
        this.onStreamEnd(message, final);
      }
    });
    this.stream = req;
  }

  private onStreamEnd(message: string, final: boolean): void {
    this.stream = null;
    if (!this.alive) {
      return;
    }
    if (final) {
      this.status = message;
      if (message !== HarnessClient.KEY_REJECTED) {
        // 任务在远程机器上已经不在了:下一条消息新建一个。
        ChatLaunch.sessions.delete(ChatLaunch.key(this.machine, ChatLaunch.harness));
        this.sessionId = '';
      }
      return;
    }
    // 一轮已经收尾,Mac 随后正常关了流:不再重连(原来点停止后每秒重连一次、停不下来),
    // 发下一条消息时再接上。
    if (this.ended && message === '已断开') {
      return;
    }
    this.scheduleReconnect(message);
  }

  private scheduleReconnect(message: string): void {
    if (this.reconnects >= MAX_RECONNECTS) {
      this.status = '连不上了,发一条消息会再试';
      return;
    }
    const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnects));
    this.reconnects += 1;
    this.status = `${message} · 重连 ${this.reconnects}/${MAX_RECONNECTS}`;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.listen(this.lastSeq);
    }, delay);
  }

  private onEvent(obj: Record<string, Object>): void {
    // 续传信封:gap 表示中间有一段已经拿不到了,从能拿到的地方接上(不再傻等那一段)。
    if (`${obj['type'] ?? ''}` === 'resume') {
      if (`${obj['status'] ?? ''}` === 'gap') {
        this.lastSeq = Math.max(this.lastSeq, Number(obj['min_after'] ?? 0));
        this.push('system', '中间有一段记录已经拿不到了,从能拿到的地方接着显示');
      }
      return;
    }
    const seq = Number(obj['seq'] ?? 0);
    if (seq > 0 && seq <= this.lastSeq) {
      // 重连回放里已经显示过的。原来每来一帧都把重连计数清零,回放本身就让它永远到不了上限。
      return;
    }
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
      this.reconnects = 0;
    }
    const name = `${obj['event'] ?? ''}`;
    if (name === 'user.message') {
      this.ended = false;
      const text = `${obj['text'] ?? ''}`;
      const echo = this.pendingEcho.indexOf(text);
      if (echo >= 0) {
        this.pendingEcho.splice(echo, 1);
        return;
      }
      this.push('user', text);
    } else if (name === 'message.delta') {
      this.ended = false;
      this.appendAssistant(`${obj['delta'] ?? ''}`);
      this.status = '进行中';
    } else if (name === 'session.note') {
      this.push('system', `${obj['text'] ?? ''}`);
    } else if (name === 'run.completed' || name === 'run.failed' || name === 'run.cancelled') {
      // 一轮结束,这一轮挂着的审批都作废了(Mac 也会补发拒绝回执)。
      this.approvalQueue = [];
      this.approval = new ApprovalState();
      if (name === 'run.completed') {
        const output = `${obj['output'] ?? ''}`;
        if (output.length > 0 && !this.liveLine) {
          this.push('assistant', output);
        }
        this.status = '空闲';
      } else if (name === 'run.failed') {
        this.push('system', `${obj['error'] ?? obj['message'] ?? '失败了'}`);
        this.status = '失败了';
      } else {
        this.push('system', '已停止');
        this.status = '已停止';
      }
      this.liveLine = null;
      this.liveText = '';
      this.ended = true;
    } else if (name === 'approval.request') {
      this.ended = false;
      const next = new ApprovalState();
      next.id = `${obj['approval_id'] ?? ''}`;
      next.command = `${obj['command'] ?? obj['description'] ?? ''}`;
      const offered = obj['choices'];
      if (Array.isArray(offered)) {
        for (let i = 0; i < offered.length; i++) {
          next.choices.push(`${offered[i]}`);
        }
      }
      if (next.choices.length === 0) {
        next.choices = ['once', 'deny'];
      }
      if (!next.id) {
        return;
      }
      for (let i = 0; i < this.approvalQueue.length; i++) {
        if (this.approvalQueue[i].id === next.id) {
          return;
        }
      }
      this.approvalQueue.push(next);
      this.approval = this.approvalQueue[0];
      this.status = '需要审批';
    } else if (name === 'approval.responded') {
      this.dropApproval(`${obj['approval_id'] ?? ''}`);
    }
  }

  private dropApproval(id: string): void {
    if (!id) {
      return;
    }
    this.approvalQueue = this.approvalQueue.filter((row: ApprovalState) => row.id !== id);
    this.approval = this.approvalQueue.length > 0 ? this.approvalQueue[0] : new ApprovalState();
    this.status = this.approval.id.length > 0 ? '需要审批' : '进行中';
  }

  private push(role: string, text: string): ChatLine | null {
    if (!text) {
      return null;
    }
    const line = new ChatLine();
    line.role = role;
    line.text = text;
    this.lines = this.lines.concat([line]);
    this.scrollTail();
    return line;
  }

  private scrollTail(): void {
    setTimeout(() => {
      try {
        this.scroller.scrollEdge(Edge.Bottom);
      } catch (_err) {
        // 列表还没挂上
      }
    }, 0);
  }

  private appendAssistant(delta: string): void {
    if (!delta) {
      return;
    }
    const live = this.liveLine;
    if (live && this.lines.length > 0 && this.lines[this.lines.length - 1] === live) {
      live.text += delta;
      this.liveText = live.text;
      this.scrollTail();
      return;
    }
    // 第一段,或中间插进来一条说明:另起一段(原来会接在那条说明后面)
    this.liveLine = this.push('assistant', delta);
    this.liveText = delta;
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || !this.client) {
      return;
    }
    this.draft = '';
    // 先显示,再等 Mac 回话;Mac 的回显到了就认作这一条,不再显示第二遍。
    this.pendingEcho.push(text);
    const line = this.push('user', text);
    this.status = '进行中';
    try {
      // 这台鸿蒙开了「全自动」时,Mac 上的 LeoPhoneAgent 任务也按全自动跑(和 iOS 一样跟着本机的开关)。
      const zcode = ChatLaunch.harness === 'zcode';
      const auto = zcode && SensitiveToolGate.fullAuto && !this.fullAutoRefused;
      if (!this.sessionId) {
        // 第一条消息才在 Mac 上建任务,建的同时就跑这一句。
        this.sessionId = await this.createTask(text, auto);
        ChatLaunch.sessions.set(ChatLaunch.key(this.machine, ChatLaunch.harness), this.sessionId);
        this.listen(0);
      } else {
        await this.client.send(this.sessionId, text, '', zcode ? (auto ? 1 : 0) : -1);
        if (!this.stream) {
          this.reconnects = 0;
          this.listen(this.lastSeq);
        }
      }
    } catch (err) {
      // 没送到:从对话里拿掉,原文放回输入框,说清原因(原来输入框先清空,这句话就没了)。
      const echo = this.pendingEcho.indexOf(text);
      if (echo >= 0) {
        this.pendingEcho.splice(echo, 1);
      }
      this.lines = this.lines.filter((row: ChatLine) => row !== line);
      this.draft = text;
      const reason = err instanceof Error ? err.message : `${err}`;
      this.status = `没送到:${reason}`;
    }
  }

  private async createTask(text: string, auto: boolean): Promise<string> {
    const client = this.client as HarnessClient;
    try {
      return await client.create(ChatLaunch.harness, text, '', auto);
    } catch (err) {
      if (!auto || !(err instanceof HttpError) || err.code !== 403) {
        throw err as Error;
      }
      // 旧版 Mac 或中继还认不出这台设备:这次逐项审批,不再每条都提示。
      this.fullAutoRefused = true;
      this.push('system', `Mac 没接受全自动(${err.message}),这次会逐项请你审批`);
      return await client.create(ChatLaunch.harness, text, '', false);
    }
  }

  private async stop(): Promise<void> {
    if (!this.sessionId || !this.client) {
      return;
    }
    try {
      await this.client.stop(this.sessionId);
    } catch (err) {
      this.status = err instanceof Error ? err.message : `${err}`;
    }
  }

  private async answer(choice: string, thenStop: boolean): Promise<void> {
    const current = this.approval;
    if (!current.id || !this.client) {
      return;
    }
    try {
      await this.client.approve(this.sessionId, choice, current.id);
      this.dropApproval(current.id);
      if (thenStop) {
        await this.stop();
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === 409) {
        // 已经在别处答过,或这一轮已经结束:没什么可答的了。
        this.dropApproval(current.id);
        return;
      }
      // 403 之类是 Mac 自己的答复(比如这台设备只能拒绝这类操作):卡片留着,把原因说出来。
      this.status = err instanceof Error ? err.message : `${err}`;
    }
  }
}
