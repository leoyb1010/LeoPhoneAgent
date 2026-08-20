import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { displayName } from '../net/Protocol';
import { ApprovalState, ChatLaunch, ChatLine, HarnessClient } from '../net/HarnessClient';
import { gatewayStore } from '../store/GatewayStore';
import { Tokens } from '../theme/Tokens';

const MAX_RECONNECTS = 8;

@Component
export struct ChatPane {
  @Prop @Watch('onMachineChange') machine: string = '';
  @State lines: ChatLine[] = [];
  @State draft: string = '';
  @State status: string = '准备中';
  @State approval: ApprovalState = new ApprovalState();
  @State lastSeq: number = 0;
  private sessionId: string = '';
  private queued: string = '';
  private client: HarnessClient | null = null;
  private stream: http.HttpRequest | null = null;
  private assistantOpen: boolean = false;
  private alive: boolean = false;
  private reconnects: number = 0;
  private reconnectTimer: number = -1;
  private approvalQueue: ApprovalState[] = [];

  aboutToAppear(): void {
    this.startSession();
  }

  aboutToDisappear(): void {
    this.teardown();
  }

  onMachineChange(): void {
    this.teardown();
    this.lines = [];
    this.draft = '';
    this.approval = new ApprovalState();
    this.approvalQueue = [];
    this.lastSeq = 0;
    this.sessionId = '';
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
            .fontColor(this.status === '审批' ? Tokens.warn : Tokens.muted)
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
          Text(this.approvalQueue.length > 1 ? `审批 · 还有 ${this.approvalQueue.length - 1} 条` : '审批')
            .fontSize(13)
            .fontColor(Tokens.warn)
          Text(this.approval.command)
            .fontSize(14)
            .fontColor('#D1D1D6')
            .margin({ top: 6, bottom: 12 })
          Row() {
            Button('批准')
              .layoutWeight(1)
              .height(40)
              .backgroundColor(Tokens.online)
              .fontColor('#000000')
              .onClick(() => {
                this.answer('once');
              })
            Button('拒绝')
              .layoutWeight(1)
              .height(40)
              .margin({ left: 8 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                this.answer('deny');
              })
          }
          .width('100%')
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
    if (!this.machine) {
      this.status = '选一台机器';
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.ensureLoaded(ctx).then(() => {
      if (!this.alive) {
        return;
      }
      this.client = new HarnessClient(gatewayStore.apiRoot, this.machine, gatewayStore.key);
      this.boot();
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

  private async boot(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.status = '正在建立会话';
    try {
      this.sessionId = await this.client.create(ChatLaunch.harness, '', '');
      this.listen(0);
      this.status = '空闲';
      if (this.queued.length > 0) {
        const text = this.queued;
        this.queued = '';
        await this.client.send(this.sessionId, text, '');
        this.push('user', text);
        this.status = '进行中';
      }
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private listen(after: number): void {
    if (!this.alive || !this.client || !this.sessionId) {
      return;
    }
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.stream = this.client.startEvents(this.sessionId, after, (obj: Record<string, Object>) => {
      this.reconnects = 0;
      this.onEvent(obj);
    }, (message: string) => {
      this.scheduleReconnect(message);
    });
  }

  private scheduleReconnect(message: string): void {
    if (!this.alive) {
      return;
    }
    if (message === 'unauthorized') {
      this.status = 'unauthorized';
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.status = '已断开，返回再进';
      return;
    }
    const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnects));
    this.reconnects += 1;
    this.status = `${message} · ${this.reconnects}/${MAX_RECONNECTS}`;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.listen(this.lastSeq);
    }, delay);
  }

  private onEvent(obj: Record<string, Object>): void {
    const seq = Number(obj['seq'] ?? 0);
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }
    const name = `${obj['event'] ?? ''}`;
    if (name === 'user.message') {
      const text = `${obj['text'] ?? ''}`;
      const last = this.lines.length > 0 ? this.lines[this.lines.length - 1] : null;
      if (last && last.role === 'user' && last.text === text) {
        return;
      }
      this.push('user', text);
    } else if (name === 'message.delta') {
      this.appendAssistant(`${obj['delta'] ?? ''}`);
      this.status = '进行中';
    } else if (name === 'run.completed') {
      const output = `${obj['output'] ?? ''}`;
      if (output.length > 0 && !this.assistantOpen) {
        this.push('assistant', output);
      }
      this.assistantOpen = false;
      this.status = this.approval.id.length > 0 ? '审批' : '空闲';
    } else if (name === 'run.failed') {
      this.push('system', `${obj['message'] ?? obj['error'] ?? '失败'}`);
      this.assistantOpen = false;
      this.status = '空闲';
    } else if (name === 'run.cancelled') {
      this.push('system', '已停止');
      this.assistantOpen = false;
      this.status = '已取消';
    } else if (name === 'approval.request') {
      const next = new ApprovalState();
      next.id = `${obj['approval_id'] ?? ''}`;
      next.command = `${obj['command'] ?? obj['description'] ?? ''}`;
      if (!next.id) {
        this.status = '缺少审批编号';
        return;
      }
      for (let i = 0; i < this.approvalQueue.length; i++) {
        if (this.approvalQueue[i].id === next.id) {
          return;
        }
      }
      this.approvalQueue.push(next);
      this.approval = this.approvalQueue[0];
      this.status = '审批';
    } else if (name === 'approval.responded') {
      const done = `${obj['approval_id'] ?? ''}`;
      if (!done) {
        return;
      }
      this.approvalQueue = this.approvalQueue.filter((row: ApprovalState) => row.id !== done);
      this.approval = this.approvalQueue.length > 0 ? this.approvalQueue[0] : new ApprovalState();
      this.status = this.approval.id.length > 0 ? '审批' : '进行中';
    }
  }

  private push(role: string, text: string): void {
    if (!text) {
      return;
    }
    const line = new ChatLine();
    line.role = role;
    line.text = text;
    this.lines = this.lines.concat([line]);
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
    if (!text) {
      return;
    }
    this.draft = '';
    if (!this.sessionId) {
      this.queued = text;
      this.status = '排队发送';
      return;
    }
    try {
      await this.client?.send(this.sessionId, text, '');
      this.push('user', text);
      this.status = '进行中';
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async stop(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      await this.client?.stop(this.sessionId);
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async answer(choice: string): Promise<void> {
    if (!this.approval.id) {
      this.status = '缺少审批编号';
      return;
    }
    const current = this.approval;
    try {
      await this.client?.approve(this.sessionId, choice, current.id);
      this.approvalQueue = this.approvalQueue.filter((row: ApprovalState) => row.id !== current.id);
      this.approval = this.approvalQueue.length > 0 ? this.approvalQueue[0] : new ApprovalState();
      this.status = this.approval.id.length > 0 ? '审批' : '进行中';
    } catch (err) {
      this.status = `${err}`;
    }
  }
}
