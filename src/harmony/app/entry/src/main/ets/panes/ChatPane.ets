import { LongAnswer } from '../chat/LongAnswer';
import { KeyedListSource, KeyedRow } from '../chat/KeyedListSource';
import { ShareMessage } from '../chat/TurnShare';
import { Voice } from '../local/Voice';
import { pasteboard } from '@kit.BasicServicesKit';
import { AppNavigation } from '../navigation/AppNavigation';
import { ActionButton } from '../theme/Controls';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { Attachments } from '../chat/Attachments';
import { WorkspaceStore } from '../store/WorkspaceStore';
import { RemoteAttachment, RemoteCapabilities, RemoteQuestion, RemoteQuestionRequest } from '../remote/RemoteModels';
import { RemoteWorkspaceLaunch } from '../remote/RemoteWorkspaceLaunch';
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { Composer } from '../chat/Composer';
import { AssistantHead, NoticeRow, UserBubble } from '../chat/ChatViews';
import { MarkdownText } from '../theme/Markdown';
import { Sym } from '../theme/Symbols';
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
  @StorageProp('themeTick') themeTick: number = 0;
  @Prop machine: string = '';
  /** 手机上推进来的一页:左上角返回。 */
  @Prop showBack: boolean = false;
  onBack: () => void = () => AppNavigation.back();
  @State follow: boolean = true;
  @State unread: number = 0;
  private scrollGeneration: number = 0;
  /** 每次从列表打开都会变:同一台机器换 Agent、换任务也要重新接上(平板两栏时这一栏不会重建)。 */
  @Prop @Watch('onLaunch') launch: number = 0;
  @State @Watch('linesChanged') lines: ChatLine[] = [];
  /** 长对话按需构建(LazyForEach)。ChatLine 没有 id,这里给每条消息发一个稳定号。 */
  private rowSource: KeyedListSource<ChatLine> = new KeyedListSource<ChatLine>();
  private lineIds: Map<ChatLine, string> = new Map<ChatLine, string>();
  private lineHeads: Map<ChatLine, boolean> = new Map<ChatLine, boolean>();
  private nextLineId: number = 0;
  @State liveText: string = '';
  @State draft: string = '';
  @State status: string = '准备中';
  @State approval: ApprovalState = new ApprovalState();
  @State lastSeq: number = 0;
  @State remoteFeatures: RemoteCapabilities = new RemoteCapabilities();
  @State question: RemoteQuestionRequest = new RemoteQuestionRequest();
  @State attachments: RemoteAttachment[] = [];
  @State sending: boolean = false;
  private questions: RemoteQuestionRequest[] = [];
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
  /**
   * 这个远程任务要不要全自动。和本机「全自动」分开:本机那个只管沙箱写文件,
   * 这里一开 Mac 上的命令就不再问你 —— 所以默认关、每次打开任务都回到关,开之前先确认。
   */
  @State macAuto: boolean = false;
  /** 每次换机器 / 换任务 +1:等回来的结果对不上就丢掉,不记到别的机器名下。 */
  private launchGen: number = 0;

  aboutToAppear(): void {
    this.startSession();
  }

  aboutToDisappear(): void {
    this.teardown();
  }

  onLaunch(): void {
    this.teardown();
    this.follow = true; this.unread = 0;
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
    this.macAuto = false;
    this.question = new RemoteQuestionRequest();
    this.questions = [];
    this.attachments = [];
    this.remoteFeatures = new RemoteCapabilities();
    this.sending = false;
    this.launchGen += 1;
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
              this.onBack();
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
          // 头像使用当前行的分组投影;位置只在操作时现查,避免每个行视图订阅整个lines。
          LazyForEach(this.rowSource, (row: KeyedRow<ChatLine>) => {
            ListItem() {
              Column() {
                if (row.value.role === 'user') {
                  Row() {
                    Blank()
                    UserBubble({ text: row.value.text, selectable: false })
                  }
                  .width('100%')
                  .margin({ top: 12, bottom: 4 })
                } else if (row.value.role === 'assistant') {
                  if (this.lineHeads.get(row.value) !== false) {
                    AssistantHead({ name: this.agentName() })
                      .margin({ top: 10 })
                  }
                  LongAnswer({ text: row.value === this.liveLine ? this.liveText : row.value.text, live: row.value === this.liveLine })
                } else {
                  NoticeRow({ text: row.value.text })
                }
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              .constraintSize({ maxWidth: Tokens.readable })
              .bindContextMenu(this.lineMenu(row.value), ResponseType.LongPress)
            }
            .width('100%')
            // key = 稳定消息号#内容版本:字、角色、头像、是否在流变了才换 key 重建;在流的那段字走 liveText
          }, (row: KeyedRow<ChatLine>) => row.key)
        }
        .cachedCount(4)
        .layoutWeight(1)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
        .contentStartOffset(8)
        .contentEndOffset(16)
        .alignListItem(ListItemAlign.Center)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        .onScrollFrameBegin((offset: number, state: ScrollState) => {
          if ((state === ScrollState.Scroll || state === ScrollState.Fling) && offset < 0) {
            this.follow = false; this.scrollGeneration++;
          }
          return { offsetRemain: offset };
        })
        .onReachEnd(() => { this.follow = true; this.unread = 0; })
      }
      if (!this.follow) ActionButton({ label: this.unread ? `${this.unread} 条新消息 · 回到底部` : '回到底部', variant: 'secondary', fullWidth: false,
        onTap: () => { this.follow = true; this.unread = 0; this.scrollTail(); } })

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
              // 批准前要能看到整条命令:长命令在框里滚动,不截断。
              Scroll() {
                Text(this.approval.command)
                  .fontSize(13)
                  .lineHeight(19)
                  .fontFamily('monospace')
                  .fontColor(Tokens.secondary)
                  .copyOption(CopyOptions.LocalDevice)
                  .width('100%')
                  .padding(10)
              }
              .scrollBar(BarState.Auto)
              .constraintSize({ maxHeight: 220 })
              .width('100%')
              .align(Alignment.TopStart)
              .backgroundColor(Tokens.chip)
              .borderRadius(10)
              .margin({ top: 8 })
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(this.approval.choices, (choice: string) => {
                  Text(choiceLabel(choice))
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(choice === 'deny' ? Tokens.text : Tokens.sendGlyph)
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
          if (this.question.id) {
            Column({ space: 8 }) {
              Text('远程任务需要你的回答').fontSize(16).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
              ForEach(this.question.questions, (item: RemoteQuestion, index: number) => {
                Text(item.question).fontSize(14).fontColor(Tokens.text)
                Flex({ wrap: FlexWrap.Wrap }) {
                  ForEach(item.labels, (label: string) => {
                    ActionButton({ label: (item.selected.includes(label) ? '✓ ' : '') + label, variant: 'secondary', fullWidth: false, onTap: () => { this.selectAnswer(index, label); } }).margin(4)
                  })
                }
                TextInput({ text: item.text, placeholder: '补充回答' }).onChange((value: string) => {
                  item.text = value;
                  this.question.questions = this.question.questions.slice();
                })
              })
              Row({ space: 10 }) {
                ActionButton({ label: '提交回答', variant: 'secondary', fullWidth: false, isEnabled: !this.sending, onTap: () => { this.answerQuestion(false); } })
                ActionButton({ label: '跳过', variant: 'secondary', fullWidth: false, isEnabled: !this.sending, onTap: () => { this.answerQuestion(true); } })
              }
            }.width('100%').padding(12).backgroundColor(Tokens.card).borderRadius(12)
          }
          Row({ space: 10 }) {
            ActionButton({ label: '工作区', variant: 'secondary', fullWidth: false, onTap: () => { this.openWorkspace(); } })
            if (this.remoteFeatures.has('attachments')) {
              ActionButton({ label: '照片', variant: 'secondary', fullWidth: false, onTap: () => { this.pickAttachment(true); } })
              ActionButton({ label: '文件', variant: 'secondary', fullWidth: false, onTap: () => { this.pickAttachment(false); } })
            }
          }.width('100%').padding({ top: 6, bottom: 6 })
          Composer({
            draft: $draft,
            placeholder: `给 ${this.machine.length > 0 ? displayName(this.machine) : '远程机器'} 发任务`,
            running: this.status === '进行中',
            showApproval: ChatLaunch.harness === 'zcode',
            fullAuto: this.macAuto,
            tools: false,
            ready: !this.sending,
            files: this.attachments.map((item: RemoteAttachment) => item.name),
            onRemoveFile: (index: number) => { this.attachments = this.attachments.filter((_item: RemoteAttachment, i: number) => i !== index); },
            showMic: false,
            onSend: () => {
              this.send();
            },
            onStop: () => {
              this.stop();
            },
            onApproval: () => {
              this.toggleMacAuto();
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

  @Builder
  lineMenu(line: ChatLine) {
    Menu() {
      if (line.role === 'user' || line.role === 'assistant') {
        MenuItem({ content: '复制' }).onClick(() => {
          pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, line.text))
            .catch(() => { this.status = '复制失败，请重试'; });
        })
        MenuItem({ content: '选择文字' }).onClick(() => AppNavigation.pushUrl({ url: 'pages/LongTextPage', params: { title: '选择文字', text: line.text } }))
        MenuItem({ content: '朗读' }).onClick(() => { Voice.speak(line.text).catch(() => { this.status = '朗读不可用'; }); })
        MenuItem({ content: '分享为长图' }).enabled(line !== this.liveLine).onClick(() => {
          const index = this.lines.indexOf(line);
          if (index >= 0) this.shareLine(index);
        })
      }
    }
  }
  private shareLine(selected: number): void {
    let start = selected;
    while (start > 0 && this.lines[start].role !== 'user') start--;
    const messages: ShareMessage[] = [];
    for (let index = start; index < this.lines.length; index++) {
      if (index > start && this.lines[index].role === 'user') break;
      const part = new ShareMessage(); part.role = this.lines[index].role; part.text = this.lines[index].text;
      messages.push(part);
    }
    AppNavigation.pushUrl({ url: 'pages/TurnSharePage', params: { messages: messages } });
  }

  private agentName(): string {
    return ChatLaunch.harness === 'zcode' || ChatLaunch.harness === 'minis' ? 'LeoBot' :
      (ChatLaunch.harness === 'claude' ? 'Claude Code' : (ChatLaunch.harness === 'codex' ? 'Codex' :
        (ChatLaunch.harness.length > 0 ? ChatLaunch.harness : 'LeoBot')));
  }

  private badStatus(): boolean {
    return this.status.indexOf('失败') >= 0 || this.status.indexOf('不对') >= 0 || this.status.indexOf('连不上') >= 0 ||
      this.status.indexOf('没送到') >= 0;
  }

  private startSession(): void {
    this.alive = true;
    const gen = this.launchGen;
    const ctx = getContext(this) as common.UIAbilityContext;
    gatewayStore.ensureLoaded(ctx).then(() => {
      if (!this.alive || gen !== this.launchGen) {
        return;
      }
      if (!this.machine) {
        this.status = '选一台机器';
        return;
      }
      this.client = new HarnessClient(gatewayStore.apiRoot, this.machine, gatewayStore.key);
      this.client.capabilities().then((features: RemoteCapabilities) => {
        if (this.alive && gen === this.launchGen) { this.remoteFeatures = features; }
      }).catch(() => {});
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
    this.scrollGeneration++;
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
    if (name === 'question.request') {
      const request = RemoteQuestionRequest.parse(obj);
      if (request.id && request.questions.length > 0 && !this.questions.some((item: RemoteQuestionRequest) => item.id === request.id)) {
        this.questions.push(request);
        this.question = this.questions[0];
        this.status = '需要回答';
      }
    } else if (name === 'question.responded') {
      this.dropQuestion(`${obj['question_id'] ?? ''}`);
    } else if (name === 'user.message') {
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
      this.questions = [];
      this.question = new RemoteQuestionRequest();
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
      this.linesChanged();
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

  private headAt(index: number): boolean {
    return index <= 0 || index >= this.lines.length || this.lines[index - 1].role !== 'assistant';
  }
  private lineId(line: ChatLine): string {
    let id = this.lineIds.get(line);
    if (id === undefined) { id = `l${this.nextLineId++}`; this.lineIds.set(line, id); }
    return id;
  }
  /** lines 整体换掉、或流式那段停下(liveLine 清空)时同步数据源;流式的字不经过这里。 */
  linesChanged(): void {
    if (this.lines.length === 0) {
      this.lineIds.clear(); this.lineHeads.clear(); this.rowSource.reset(); return;
    }
    const lines = this.lines;
    const heads: Map<ChatLine, boolean> = new Map<ChatLine, boolean>();
    for (let i = 0; i < lines.length; i++) heads.set(lines[i], this.headAt(i));
    const ids: Map<ChatLine, string> = new Map<ChatLine, string>();
    lines.forEach((line: ChatLine) => ids.set(line, this.lineId(line)));
    this.lineIds = ids;
    this.lineHeads = heads;
    this.rowSource.sync(lines, (line: ChatLine) => ids.get(line) ?? '', (line: ChatLine) =>
      `${line.role}|${heads.get(line) === true}|${line === this.liveLine ? 'live|' : 'done|' + line.text}`);
  }

  private push(role: string, text: string): ChatLine | null {
    if (!text) {
      return null;
    }
    const line = new ChatLine();
    line.role = role;
    line.text = text;
    this.lines = this.lines.concat([line]);
    if (!this.follow && role !== 'user') this.unread++;
    this.scrollTail();
    return line;
  }

  private scrollTail(): void {
    if (!this.follow) return;
    const generation = this.scrollGeneration;
    setTimeout(() => {
      if (!this.alive || !this.follow || generation !== this.scrollGeneration) return;
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
    // 上一段(若还挂着 live)此刻定稿:带完整字重建;新的一段改走 liveText。
    this.linesChanged();
  }

  private async toggleMacAuto(): Promise<void> {
    if (this.macAuto) {
      this.macAuto = false;
      return;
    }
    const gen = this.launchGen;
    try {
      const picked = await promptAction.showDialog({
        title: '这个任务改成全自动?',
        message: `${this.machine.length > 0 ? displayName(this.machine) : 'Mac'} 上的这个任务会直接执行命令、改文件,不再逐项问你。只对这一个任务有效,重新打开就恢复逐项确认。`,
        buttons: [{ text: '改成全自动', color: Tokens.warn }, { text: '取消', color: Tokens.accent }]
      });
      if (picked.index === 0 && gen === this.launchGen) {
        this.macAuto = true;
      }
    } catch (_err) {
      // 对话框被系统收起:保持逐项确认
    }
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if ((!text && this.attachments.length === 0) || !this.client || this.sending) {
      return;
    }
    const client = this.client;
    const attachments = this.attachments.slice();
    this.sending = true;
    const gen = this.launchGen;
    const machine = this.machine;
    const harness = ChatLaunch.harness;
    this.draft = '';
    // 先显示,再等 Mac 回话;Mac 的回显到了就认作这一条,不再显示第二遍。
    this.pendingEcho.push(text);
    const line = this.push('user', text);
    this.status = '进行中';
    try {
      // 只看这个任务自己的开关(macAuto),不跟本机「全自动」走;每条都明确带上,关着就是逐项确认。
      const zcode = harness === 'zcode';
      const auto = zcode && this.macAuto && !this.fullAutoRefused;
      if (!this.sessionId) {
        // 第一条消息才在 Mac 上建任务,建的同时就跑这一句。
        const created = await this.createTask(client, attachments.length > 0 ? '' : text, auto);
        if (gen !== this.launchGen) {
          // 等 Mac 回话时换了机器或任务:这个任务属于原来那台,记在它名下,不接到当前页上。
          ChatLaunch.sessions.set(ChatLaunch.key(machine, harness), created);
          return;
        }
        this.sessionId = created;
        if (attachments.length > 0) {
          ChatLaunch.sessions.set(ChatLaunch.key(machine, harness), created);
          await client.send(created, text, '', zcode ? (auto ? 1 : 0) : -1, attachments);
          if (gen !== this.launchGen) { return; }
        }
        ChatLaunch.sessions.set(ChatLaunch.key(machine, harness), this.sessionId);
        this.listen(0);
      } else {
        await client.send(this.sessionId, text, '', zcode ? (auto ? 1 : 0) : -1, attachments);
        if (gen !== this.launchGen) {
          return;
        }
        if (!this.stream) {
          this.reconnects = 0;
          this.listen(this.lastSeq);
        }
      }
      if (gen === this.launchGen) { this.attachments = []; }
    } catch (err) {
      if (gen !== this.launchGen) { return; }
      // 没送到:从对话里拿掉,原文放回输入框,说清原因(原来输入框先清空,这句话就没了)。
      const echo = this.pendingEcho.indexOf(text);
      if (echo >= 0) {
        this.pendingEcho.splice(echo, 1);
      }
      this.lines = this.lines.filter((row: ChatLine) => row !== line);
      this.draft = this.draft ? text + '\n' + this.draft : text;
      const reason = err instanceof Error ? err.message : `${err}`;
      this.status = `没送到:${reason}`;
    } finally { if (gen === this.launchGen) { this.sending = false; } }
  }

  private openWorkspace(): void {
    RemoteWorkspaceLaunch.machine = this.machine;
    RemoteWorkspaceLaunch.sessionId = this.sessionId;
    AppNavigation.pushUrl({ url: 'pages/RemoteWorkspacePage' });
  }

  private selectAnswer(index: number, label: string): void {
    const item = this.question.questions[index];
    item.selected = item.multiple ? item.selected.includes(label) ?
      item.selected.filter((value: string) => value !== label) : item.selected.concat([label]) : [label];
    this.question.questions = this.question.questions.slice();
  }

  private dropQuestion(id: string): void {
    this.questions = this.questions.filter((item: RemoteQuestionRequest) => item.id !== id);
    this.question = this.questions.length > 0 ? this.questions[0] : new RemoteQuestionRequest();
  }

  private async answerQuestion(decline: boolean): Promise<void> {
    const client = this.client;
    const current = this.question;
    const gen = this.launchGen;
    if (!client || !current.id) { return; }
    this.sending = true;
    try {
      await client.answerQuestion(this.sessionId, current, decline);
      if (this.alive && gen === this.launchGen) { this.dropQuestion(current.id); }
    } catch (err) { if (gen === this.launchGen) { this.status = `${err}`; } }
    finally { if (gen === this.launchGen) { this.sending = false; } }
  }

  private async pickAttachment(photo: boolean): Promise<void> {
    const gen = this.launchGen;
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const next: RemoteAttachment[] = [];
      if (photo) {
        const picked = await Attachments.pickImage(ctx);
        if (picked) {
          const row = new RemoteAttachment();
          row.name = picked.mime === 'image/png' ? 'photo.png' : 'photo.jpg';
          row.mime = picked.mime;
          row.data_base64 = picked.b64;
          next.push(row);
        }
      } else {
        const picked = await Attachments.pickFiles(ctx);
        for (const name of picked.names) {
          const file = fileIo.openSync(WorkspaceStore.pathOf(ctx, name), fileIo.OpenMode.READ_ONLY);
          try {
            const size = fileIo.statSync(file.fd).size;
            if (size > 6 * 1024 * 1024) { throw new Error('远程单个附件最多 6 MB'); }
            const buffer = new ArrayBuffer(size);
            if (fileIo.readSync(file.fd, buffer) !== size) { throw new Error('附件读取不完整'); }
            const row = new RemoteAttachment();
            row.name = name;
            row.mime = 'application/octet-stream';
            row.data_base64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer));
            next.push(row);
          } finally { fileIo.closeSync(file); }
        }
      }
      if (gen !== this.launchGen || !this.alive) { return; }
      const total = this.attachments.concat(next);
      const size = total.reduce((count: number, row: RemoteAttachment) => count + row.data_base64.length, 0);
      if (total.length > 5 || size > 24 * 1024 * 1024) { throw new Error('最多 5 个附件，总计约 18 MB'); }
      this.attachments = total;
    } catch (err) { if (gen === this.launchGen) { this.status = `${err}`; } }
  }

  private async createTask(client: HarnessClient, text: string, auto: boolean): Promise<string> {
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

  private async stop(forSession?: string, forClient?: HarnessClient): Promise<void> {
    const sessionId = forSession ?? this.sessionId;
    const client = forClient ?? this.client;
    if (!sessionId || !client) {
      return;
    }
    try {
      await client.stop(sessionId);
    } catch (err) {
      this.status = err instanceof Error ? err.message : `${err}`;
    }
  }

  private async answer(choice: string, thenStop: boolean): Promise<void> {
    const current = this.approval;
    const client = this.client;
    const sessionId = this.sessionId;
    if (!current.id || !client) {
      return;
    }
    try {
      await client.approve(sessionId, choice, current.id);
      this.dropApproval(current.id);
      if (thenStop) {
        // 用答题时的那台、那个任务:等回话期间换了页面,也不能停到别的任务上。
        await this.stop(sessionId, client);
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
