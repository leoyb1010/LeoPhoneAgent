import { http } from '@kit.NetworkKit';
import { displayName } from '../net/Protocol';
import { ApprovalState, ChatLaunch, ChatLine, HarnessClient } from '../net/HarnessClient';
import { gatewayStore } from '../store/GatewayStore';

@Entry
@Component
struct RemoteChatPage {
  @State lines: ChatLine[] = [];
  @State draft: string = '';
  @State status: string = '准备中';
  @State machine: string = '';
  @State approval: ApprovalState = new ApprovalState();
  @State lastSeq: number = 0;
  private sessionId: string = '';
  private queued: string = '';
  private client: HarnessClient | null = null;
  private stream: http.HttpRequest | null = null;
  private assistantOpen: boolean = false;

  aboutToAppear(): void {
    this.machine = ChatLaunch.machine;
    this.client = new HarnessClient(gatewayStore.apiRoot, this.machine, gatewayStore.key);
    this.boot();
  }

  aboutToDisappear(): void {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
  }

  build() {
    Column() {
      Text(displayName(this.machine))
        .fontSize(18)
        .fontColor('#F2F2F4')
        .width('100%')
        .padding({ left: 20, right: 20, top: 16 })
      Text(this.status)
        .fontSize(12)
        .fontColor('#8E8E93')
        .width('100%')
        .padding({ left: 20, bottom: 8 })

      List() {
        ForEach(this.lines, (line: ChatLine, index: number) => {
          ListItem() {
            Text(line.text)
              .fontSize(15)
              .fontColor(line.role === 'user' ? '#FFFFFF' : '#F2F2F4')
              .padding(12)
              .backgroundColor(line.role === 'user' ? '#E85030' : '#1C1C1E')
              .borderRadius(12)
              .constraintSize({ maxWidth: '86%' })
          }
          .align(line.role === 'user' ? Alignment.End : Alignment.Start)
          .padding({ left: 12, right: 12, top: 6, bottom: 6 })
        }, (line: ChatLine, index: number) => `${index}:${line.role}:${line.text.length}`)
      }
      .layoutWeight(1)
      .width('100%')

      if (this.approval.id.length > 0) {
        Column() {
          Text('审批')
            .fontSize(13)
            .fontColor('#FF9F0A')
          Text(this.approval.command)
            .fontSize(13)
            .fontColor('#D1D1D6')
            .margin({ top: 4, bottom: 8 })
          Row() {
            Button('批准')
              .layoutWeight(1)
              .backgroundColor('#30D158')
              .fontColor('#000000')
              .onClick(() => {
                this.answer('once');
              })
            Button('拒绝')
              .layoutWeight(1)
              .margin({ left: 8 })
              .backgroundColor('#2C2C2E')
              .fontColor('#F2F2F4')
              .onClick(() => {
                this.answer('deny');
              })
          }
          .width('100%')
        }
        .width('100%')
        .padding(12)
        .backgroundColor('#2C2C2E')
      }

      Row() {
        TextInput({ placeholder: '发一条新任务', text: this.draft })
          .layoutWeight(1)
          .backgroundColor('#1C1C1E')
          .fontColor('#F2F2F4')
          .placeholderColor('#6E6E73')
          .onChange((value: string) => {
            this.draft = value;
          })
        Button('发送')
          .margin({ left: 8 })
          .backgroundColor('#E85030')
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.send();
          })
        Button('停止')
          .margin({ left: 8 })
          .backgroundColor('#2C2C2E')
          .fontColor('#F2F2F4')
          .onClick(() => {
            this.stop();
          })
      }
      .width('100%')
      .padding(12)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#121214')
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
    if (!this.client) {
      return;
    }
    if (this.stream) {
      this.stream.destroy();
    }
    this.stream = this.client.startEvents(this.sessionId, after, (obj: Record<string, Object>) => {
      this.onEvent(obj);
    }, (message: string) => {
      this.status = message;
      this.listen(this.lastSeq);
    });
  }

  private onEvent(obj: Record<string, Object>): void {
    const seq = Number(obj['seq'] ?? 0);
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }
    const name = `${obj['event'] ?? ''}`;
    if (name === 'user.message') {
      this.push('user', `${obj['text'] ?? ''}`);
    } else if (name === 'message.delta') {
      this.appendAssistant(`${obj['delta'] ?? ''}`);
      this.status = '进行中';
    } else if (name === 'run.completed') {
      const output = `${obj['output'] ?? ''}`;
      if (output.length > 0 && !this.assistantOpen) {
        this.push('assistant', output);
      }
      this.assistantOpen = false;
      this.status = '空闲';
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
      this.approval = next;
      this.status = '审批';
    } else if (name === 'approval.responded') {
      this.approval = new ApprovalState();
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
    try {
      await this.client?.approve(this.sessionId, choice, this.approval.id);
      this.approval = new ApprovalState();
    } catch (err) {
      this.status = `${err}`;
    }
  }
}
