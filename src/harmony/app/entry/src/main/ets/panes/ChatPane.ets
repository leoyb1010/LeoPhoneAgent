import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { displayName } from '../net/Protocol';
import { ApprovalState, ChatLaunch, ChatLine, HarnessClient, HttpError } from '../net/HarnessClient';
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
  @Prop machine: string = '';
  /** 每次从列表打开都会变:同一台机器换 Agent、换任务也要重新接上(平板两栏时这一栏不会重建)。 */
  @Prop @Watch('onLaunch') launch: number = 0;
  @State lines: ChatLine[] = [];
  @State draft: string = '';
  @State status: string = '准备中';
  @State approval: ApprovalState = new ApprovalState();
  @State lastSeq: number = 0;
  private sessionId: string = '';
  private client: HarnessClient | null = null;
  private stream: http.HttpRequest | null = null;
  private assistantOpen: boolean = false;
  private alive: boolean = false;
  private reconnects: number = 0;
  private reconnectTimer: number = -1;
  private approvalQueue: ApprovalState[] = [];
  /** 自己发出去、还没等到回显的话:Mac 的回显到了就不再显示第二遍。 */
  private pendingEcho: string[] = [];
  /** 这一轮已经收尾(完成、失败、停止):流随后正常关闭时不再重连,发下一条再接上。 */
  private ended: boolean = false;

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
    this.assistantOpen = false;
    this.ended = false;
    this.reconnects = 0;
    this.startSession();
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text(this.machine.length > 0 ? displayName(this.machine) : '新任务')
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
          Text(this.status)
            .fontSize(12)
            .fontColor(this.status === '需要审批' ? Tokens.warn : Tokens.muted)
            .margin({ top: 4 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 8, bottom: 12 })

      if (this.machine.length === 0) {
        Column() {
          Text('选一台在线机器')
            .fontSize(20)
            .fontColor(Tokens.text)
          Text('外屏点进机器就是这一页。展开内屏后，左边列表、右边对话。')
            .fontSize(14)
            .fontColor(Tokens.muted)
            .margin({ top: 8 })
            .textAlign(TextAlign.Center)
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .padding(24)
      } else {
        List() {
          ForEach(this.lines, (line: ChatLine, index: number) => {
            ListItem() {
              Text(line.text)
                .fontSize(16)
                .fontColor(line.role === 'user' ? '#FFFFFF' : Tokens.text)
                .padding({ left: 14, right: 14, top: 10, bottom: 10 })
                .backgroundColor(line.role === 'user' ? Tokens.accent :
                  (line.role === 'system' ? Tokens.surface2 : Tokens.surface))
                .borderRadius(14)
                .constraintSize({ maxWidth: '78%' })
            }
            .align(line.role === 'user' ? Alignment.End : Alignment.Start)
            .padding({ left: 16, right: 16, top: 6, bottom: 6 })
            // 同 LocalChatPane：key 里带 text.length 会让流式中的最后一条气泡被反复销毁重建
          }, (line: ChatLine, index: number) => `${index}:${line.role}`)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
      }

      if (this.approval.id.length > 0) {
        Column() {
          Text(this.approvalQueue.length > 1 ? `需要审批 · 还有 ${this.approvalQueue.length - 1} 条` : '需要审批')
            .fontSize(13)
            .fontColor(Tokens.warn)
          Text(this.approval.command)
            .fontSize(14)
            .fontColor(Tokens.text)
            .margin({ top: 6, bottom: 12 })
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.approval.choices, (choice: string) => {
              Button(choiceLabel(choice))
                .height(40)
                .margin({ right: 8, bottom: 8 })
                .backgroundColor(choice === 'deny' ? Tokens.surface2 : Tokens.online)
                .fontColor(choice === 'deny' ? Tokens.text : '#000000')
                .onClick(() => {
                  this.answer(choice, false);
                })
            }, (choice: string) => choice)
          }
          .width('100%')
          Text('拒绝并停止任务')
            .fontSize(13)
            .fontColor(Tokens.muted)
            .onClick(() => {
              this.answer('deny', true);
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(16)
        .margin({ left: 12, right: 12, bottom: 8 })
        .backgroundColor(Tokens.surface)
        .borderRadius(16)
      }

      if (this.machine.length > 0) {
        Row() {
          TextInput({ placeholder: '发一条新任务', text: this.draft })
            .layoutWeight(1)
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(12)
            .onChange((value: string) => {
              this.draft = value;
            })
          Button('发送')
            .height(44)
            .margin({ left: 8 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.send();
            })
          Button('停止')
            .height(44)
            .margin({ left: 8 })
            .backgroundColor(Tokens.surface2)
            .fontColor(Tokens.text)
            .onClick(() => {
              this.stop();
            })
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: 16, top: 4 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
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
        if (output.length > 0 && !this.assistantOpen) {
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
      this.assistantOpen = false;
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
    return line;
  }

  private appendAssistant(delta: string): void {
    if (!delta) {
      return;
    }
    if (!this.assistantOpen) {
      this.push('assistant', delta);
      this.assistantOpen = true;
      return;
    }
    const copy = this.lines.slice();
    const last = copy[copy.length - 1];
    last.text += delta;
    this.lines = copy;
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
      if (!this.sessionId) {
        // 第一条消息才在 Mac 上建任务,建的同时就跑这一句。
        this.sessionId = await this.client.create(ChatLaunch.harness, text, '');
        ChatLaunch.sessions.set(ChatLaunch.key(this.machine, ChatLaunch.harness), this.sessionId);
        this.listen(0);
      } else {
        await this.client.send(this.sessionId, text, '');
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
