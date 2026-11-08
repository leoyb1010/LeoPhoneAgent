import { GeneratedMedia } from './GeneratedMedia';
import { fileIo } from '@kit.CoreFileKit';
import { ChatViewState } from './ChatViewState';
import { util } from '@kit.ArkTS';
import { LinuxRuntime } from './LinuxRuntime';
import { MailTools } from './MailTools';
import { conversationHistory } from './ConversationHistory';
import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { FastLocalActions } from './FastLocalActions';
import { LocalTools, ToolResult } from './LocalTools';
import { OpenAICompatClient, StreamTurn } from './OpenAICompatClient';
import { SensitiveToolGate } from './SensitiveToolGate';
import { SideModel } from './SideModel';
import { SubAgentTasks } from './SubAgentTasks';
import {
  ChatImage,
  chatImages,
  FailoverSlot,
  LOOP_STOP_AT,
  LOOP_WARN_AT,
  LocalChatMessage,
  LoopTurn,
  MAX_TOOL_ROUNDS,
  ToolCall,
  ToolLoopGuard,
  friendlyModelError,
  loopWarning,
  sandboxFileName,
  shouldFailover,
  titleFromPrompt,
  toolArg
} from './LocalProtocol';
import {
  COMPACT_AT_CHARS,
  COMPACT_KEEP_USER_TURNS,
  COMPACT_SYSTEM_PROMPT,
  TITLE_ATTEMPTS,
  TITLE_SYSTEM_PROMPT,
  TextLine,
  compactCut,
  compactTranscript,
  compactUserMessage,
  doneNotice,
  historyChars,
  lastSummaryIndex,
  parseTitleReply,
  titleExcerpt,
  titlePrompt,
  toolPlanLine,
  toolResultLine,
  unfinishedTail
} from './AgentText';
import { memoryStore } from '../store/MemoryStore';
import { ModelGroup, ProviderInstance, ProviderRunSlot, providerStore } from '../store/ProviderStore';
import { LocalSession, SessionStore, sessionStore } from '../store/SessionStore';
import { taskStatus } from '../store/TaskStatus';
import { usageStore } from '../store/UsageStore';

const PKG = 'com.leoyuan.leophoneagent.harmony';

/** 会话消息 → 纯文本逻辑(AgentText)用的行。 */
export function textLines(messages: LocalChatMessage[]): TextLine[] {
  return messages.map((row: LocalChatMessage) => {
    const line = new TextLine();
    line.role = row.role;
    line.text = row.text;
    line.kind = row.kind;
    line.at = row.at;
    return line;
  });
}

function hashOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 这次要带上的图片(相机或相册选的那一张)。 */
class NativeWriteArgs { path: string = ''; text: string = ''; }
export class PendingImage extends ChatImage {}

/**
 * 本机的一个对话,和它正在跑的那一轮。原来这一切都长在聊天页上:离开页面、切到别的对话,这一轮就被作废。
 * 现在对话由 ChatRuns 按 id 留在内存里,页面只是看它 —— 离开页面、App 退到后台都接着跑
 * (iOS 的会话缓存、安卓的全局 ViewModel 是同一个意思),说完了 App 在后台就发通知。
 *
 * 每一轮带一个 gen:停止、重新生成、发新消息都会让 runGen 前进,旧一轮还没回来的回调和工具看到对不上就收手。
 * (原来页面上用一个 myGen 跟着 runGen 走,停下后马上再发,旧一轮等在工具上的那一步会被当成新的接着跑。)
 */
export class ChatRun {
  readonly sessionId: string;
  memoryEnabled: boolean = true;
  actualModel: string = '';
  actualProviderId: string = '';
  private readonly context: common.UIAbilityContext;
  lines: LocalChatMessage[] = [];
  title: string = '本机 Agent';
  status: string = '准备中';
  askWrite: boolean = false;
  /** 上一轮没做完(App 被杀、出错、你点了停止):显示「继续」。 */
  interrupted: boolean = false;
  /** 有一轮在跑(等你确认写文件时不算)。 */
  active: boolean = false;
  loaded: boolean = false;
  /** 正在看它的页面数:都走了、又不在跑的对话才从内存里清掉。 */
  viewers: number = 0;
  private pausedByBackground: boolean = false;
  private thinking: string = '';
  private pendingCalls: ToolCall[] = [];
  private pendingNative: ToolCall | null = null;
  private pendingNativeSubmission: string = '';
  private approvalCall: ToolCall | null = null;
  private approvalGeneration: number = -1;
  private approvalTicket: string = '';
  private approvalResource: string = '';
  private loopTurns: LoopTurn[] = [];
  private rounds: number = 0;
  private sending: boolean = false;
  private submissionId: string = '';
  get submitting(): boolean { return this.sending; }
  private failIndex: number = 0;
  private modelClients: Map<number, OpenAICompatClient> = new Map();
  private modelQueue: ProviderRunSlot[] = [];
  private runGen: number = 0;
  private loopGuard: ToolLoopGuard = new ToolLoopGuard();
  private stream: http.HttpRequest | null = null;
  private streamBuf: string = '';
  private streamTick: number = -1;
  private streamDone: boolean = false;
  private assistantOpen: boolean = false;
  private titleTries: number = 0;

  constructor(context: common.UIAbilityContext, sessionId: string) {
    this.context = context;
    this.sessionId = sessionId;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await Promise.all([
      providerStore.ensureLoaded(this.context),
      sessionStore.ensureLoaded(this.context),
      LocalTools.hydrate(this.context)
    ]);
    const session = await sessionStore.get(this.context, this.sessionId);
    this.loaded = true;
    if (!session) {
      this.status = '这个对话不在了';
      this.changed();
      return;
    }
    this.title = session.title; this.memoryEnabled = session.memoryEnabled;
    this.lines = session.messages.slice();
    this.interrupted = session.running || unfinishedTail(textLines(session.messages));
    this.status = this.interrupted ? '上一轮没做完,可以点「继续」' : '空闲';
    this.changed();
  }

  /** 发一句话:先试本机快捷动作,斜杠命令走本机,其余交给模型。 */
  async send(text: string, image: PendingImage | null, files: string[], thinking: string, submissionId: string = '', images: PendingImage[] = []): Promise<void> {
    if (this.active || this.sending) return;
    this.sending = true; this.submissionId = submissionId;
    try { await this.sendMessage(text, image, files, thinking, images); } finally { this.sending = false; }
  }

  private async sendMessage(text: string, image: PendingImage | null, files: string[], thinking: string, images: PendingImage[] = []): Promise<void> {
    const attached = images.length ? images : (image ? [image] : []);
    if (attached.length > 16) throw new Error('单条消息最多16张图片');
    this.thinking = thinking;
    const nativeGeneration = this.runGen;
    if (text.length > 0 && files.length === 0) {
      const spoken = await FastLocalActions.tryRoute(this.context, text, attached.length, false, () => nativeGeneration === this.runGen);
      if (nativeGeneration !== this.runGen) return;
      if (spoken.length > 0) {
        await this.finishNative(text, spoken);
        return;
      }
    }
    if (text.startsWith('/')) { await this.runSlash(text); return; }
    const boundSession = await sessionStore.get(this.context, this.sessionId);
    if (boundSession && boundSession.unresolvedModelId) {
      this.status = `请先选择 AI 服务商中的模型（原模型 ${boundSession.unresolvedModelId}）`; this.changed(); return;
    }
    const hasBinding = boundSession !== null && boundSession.modelQueue.length > 0;
    if (!hasBinding && !providerStore.configured()) {
      this.status = '未配置 AI 服务商';
      this.changed();
      return;
    }
    const line = new LocalChatMessage();
    line.role = 'user';
    line.text = (text.length > 0 ? text : (attached.length ? '看看这些图片' : '看看这些文件')) + (attached.length ? `\n[${attached.length}张图片]` : '');
    line.images = attached.slice();
    if (attached.length) {
      image = attached[0];
      line.imageB64 = image.b64;
      line.imageMime = image.mime;
      line.imagePath = image.path;
    }
    line.files = files.slice(); line.submissionId = this.submissionId;
    await sessionStore.appendLine(this.context, this.sessionId, line);
    ChatViewState.admitted(this.sessionId, this.submissionId);
    this.lines = this.lines.concat([line]);
    await this.refreshTitle();
    await this.start();
  }

  /** 「继续」:最后是用户的话就重跑它;否则补一句继续(带上被打断那一轮已经跑过的工具)。 */
  async resume(thinking: string): Promise<void> {
    this.thinking = thinking;
    const session = await sessionStore.get(this.context, this.sessionId);
    if (!session || this.active) {
      return;
    }
    let lastIsUser = false;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].kind === 'summary') {
        continue;
      }
      lastIsUser = session.messages[i].role === 'user';
      break;
    }
    if (!lastIsUser) {
      const line = new LocalChatMessage();
      line.role = 'user';
      line.kind = 'resume';
      line.text = '继续';
      await sessionStore.appendLine(this.context, this.sessionId, line);
      this.lines = this.lines.concat([line]);
    }
    this.pausedByBackground = false;
    await this.start();
  }

  async regenerate(thinking: string): Promise<void> {
    if (this.active) {
      return;
    }
    const session = await sessionStore.get(this.context, this.sessionId);
    if (!session) {
      return;
    }
    let lastUser = -1;
    for (let i = 0; i < session.messages.length; i++) {
      if (session.messages[i].role === 'user') {
        lastUser = i;
      }
    }
    if (lastUser < 0) {
      return;
    }
    this.stopStream();
    session.messages = session.messages.slice(0, lastUser + 1);
    await sessionStore.replaceMessages(this.context, session);
    this.lines = session.messages.slice();
    this.thinking = thinking;
    await this.start();
  }

  /** 停止:没说完的回答存下来(标成没说完),之后能「继续」。 */
  async stop(): Promise<void> {
    LinuxRuntime.cancelOwner(this.sessionId);
    MailTools.cancel(this.sessionId);
    const partial = this.assistantOpen || this.streamBuf.length > 0;
    this.flushStream();
    const last = this.lines.length > 0 ? this.lines[this.lines.length - 1] : null;
    this.cancelRun();
    this.active = false;
    taskStatus.setRunning(false, this.sessionId);
    if (partial && last && last.role === 'assistant' && last.text.trim().length > 0) {
      const line = new LocalChatMessage();
      line.role = 'assistant';
      line.kind = 'partial';
      line.text = last.text;
      await sessionStore.appendLine(this.context, this.sessionId, line).catch(() => {
        // 存不下来也停
      });
    }
    await sessionStore.setRunning(this.context, this.sessionId, false).catch(() => {
      // 停下照样有效
    });
    this.status = '已停止';
    this.interrupted = true;
    this.changed();
  }

  allowWrite(sessionWide: boolean, displayedTicket: string): void {
    if (!displayedTicket || displayedTicket !== this.approvalToken()) throw new Error('审批内容已变化，请重新查看当前操作');
    const granted = sessionWide ? SensitiveToolGate.grantSession(this.sessionId, displayedTicket) : SensitiveToolGate.grantWriteOnce(this.sessionId, displayedTicket);
    if (!granted) throw new Error('审批已失效，请重新查看当前操作');
    this.askWrite = false; taskStatus.setPendingWrite(false, this.sessionId);
    this.status = sessionWide ? '已允许本会话同类操作' : '已允许这一次';
    if (this.pendingNative) this.finishPendingNative(this.runGen).catch((error: Error) => { this.status = error.message; this.changed(); });
    else this.continueTools();
  }

  denyWrite(stop: boolean, displayedTicket: string): void {
    if (!displayedTicket || displayedTicket !== this.approvalToken()) throw new Error('审批内容已变化，请重新查看当前操作');
    if (this.pendingNative) {
      this.pendingNative = null; this.pendingNativeSubmission = ''; this.clearApproval(); this.askWrite = false; taskStatus.setPendingWrite(false, this.sessionId);
      this.status = '已拒绝本机操作'; this.changed(); if (stop) this.stop(); return;
    }
    const calls = this.pendingCalls.slice();
    if (stop || calls.length === 0) {
      this.stop();
      return;
    }
    this.askWrite = false;
    this.pendingCalls = [];
    taskStatus.setPendingWrite(false, this.sessionId);
    // 每个没执行的调用都要回一条结果,不然下一轮请求会因为「有调用没有结果」被服务商拒掉。
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = call.id.length > 0 ? call.id : `call_${i}`;
      tool.toolName = call.name;
      tool.content = (call.name === 'file_write' || call.name === 'file_edit') ?
        SensitiveToolGate.denialMessage(ChatRun.pathOf(call)) :
        '没有执行，前面的操作已被用户拒绝。';
      this.loopTurns = this.loopTurns.concat([tool]);
    }
    this.clearApproval();
    this.push('system', '已拒绝这次操作');
    this.markActive();
    this.startModel(this.runGen);
  }

  /** 刚切到全自动:正在等的这次写文件一并放行(Mac 端也是这么做的)。 */
  onFullAuto(): void {
    if (SensitiveToolGate.fullAuto && this.askWrite && (this.pendingCalls.length > 0 || this.pendingNative !== null)) {
      this.askWrite = false;
      taskStatus.setPendingWrite(false, this.sessionId);
      if (this.pendingNative) this.finishPendingNative(this.runGen).catch((error: Error) => { this.status = error.message; this.changed(); });
      else this.continueTools();
    }
  }

  writeAskTitle(): string {
    const call = this.approvalCall; const path = call ? ChatRun.pathOf(call) : '';
    const name = call?.name ?? '';
    if (name === 'shell_execute') return '运行 Linux 命令，等你确认';
    if (name === 'browser_use') return '操作浏览器页面，等你确认';
    if (name.startsWith('calendar_')) return SensitiveToolGate.requiresPersonalRead(name, call?.args ?? '{}') ? '读取日历资料，等你确认' : '修改日历，等你确认';
    if (name.startsWith('contacts_')) return SensitiveToolGate.requiresPersonalRead(name, call?.args ?? '{}') ? '读取联系人资料，等你确认' : '修改联系人，等你确认';
    if (call && SensitiveToolGate.requiresPersonalRead(name, call.args)) return '读取个人资料，等你确认';
    return path.length > 0 ? `要写文件:${path}` : '此操作需要你确认';
  }

  approvalToken(): string {
    if (!this.askWrite || this.approvalGeneration !== this.runGen || !this.approvalCall) return '';
    const actual = this.pendingNative ?? this.pendingCalls[0];
    return actual && actual.id === this.approvalCall.id && actual.name === this.approvalCall.name && actual.args === this.approvalCall.args ? this.approvalTicket : '';
  }

  writeAskDetails(): string {
    if (!this.approvalToken() || !this.approvalCall) return '这项审批已变化，请等待当前操作刷新';
    let args = this.approvalCall.args;
    try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (_error) {}
    return this.approvalCall.name + (this.approvalResource ? '\n目标 ' + this.approvalResource : '') + '\n' + args;
  }

  private freezeApproval(call: ToolCall, generation: number): void {
    const resource = SensitiveToolGate.resource(this.sessionId);
    const snapshot = new ToolCall(); snapshot.id = call.id; snapshot.name = call.name; snapshot.args = call.args;
    this.approvalCall = snapshot; this.approvalGeneration = generation; this.approvalTicket = util.generateRandomUUID(); this.approvalResource = resource;
    SensitiveToolGate.beginOperation(this.sessionId, this.approvalTicket, call.name, call.args); SensitiveToolGate.setResource(this.sessionId, resource);
  }

  private clearApproval(): void {
    this.approvalTicket = ''; this.approvalCall = null; this.approvalGeneration = -1; this.approvalResource = '';
    SensitiveToolGate.revokeOperation(this.sessionId);
  }

  private async finishPendingNative(generation: number): Promise<void> {
    const call = this.pendingNative; if (!call || generation !== this.runGen) return;
    const result = LocalTools.writeSandbox(this.context, toolArg(call.args, 'path'), toolArg(call.args, 'text'), this.sessionId);
    if (result === '__NEED_WRITE_GRANT__') { this.askWrite = true; taskStatus.setPendingWrite(true, this.sessionId); this.changed(); return; }
    const submission = this.pendingNativeSubmission; this.pendingNativeSubmission = ''; this.pendingNative = null; this.clearApproval();
    const line = new LocalChatMessage(); line.role = 'system'; line.text = result; line.submissionId = submission;
    await sessionStore.appendLine(this.context, this.sessionId, line); ChatViewState.admitted(this.sessionId, line.submissionId);
    if (generation !== this.runGen) return;
    this.push('system', result); this.status = '空闲'; this.changed();
  }

  /** 工具要写的沙箱文件名;路径不合法时返回空(不能在点按钮时抛出去)。 */
  private static pathOf(call: ToolCall): string {
    try {
      return sandboxFileName(toolArg(call.args, 'path'));
    } catch (_err) {
      return '';
    }
  }

  /** 手动压缩(/compact),或发送前太长时自动压缩:前面的对话换成模型写的摘要,最近几轮原样留着。 */
  async compact(manual: boolean): Promise<boolean> {
    const session = await sessionStore.get(this.context, this.sessionId);
    if (!session) {
      return false;
    }
    const all = textLines(session.messages);
    let at = compactCut(all, COMPACT_KEEP_USER_TURNS);
    if (at < 0 && manual) {
      at = compactCut(all, 1);
    }
    if (at < 0) {
      if (manual) {
        this.push('system', '对话还短,不用压缩');
      }
      return false;
    }
    const start = lastSummaryIndex(all);
    const previous = start >= 0 ? session.messages[start].text : '';
    const gen = this.runGen;
    const before = this.status;
    this.status = '正在压缩前面的对话';
    this.changed();
    const summary = await SideModel.complete(this.context, COMPACT_SYSTEM_PROMPT,
      compactUserMessage(compactTranscript(all.slice(start + 1, at), previous)));
    if (gen !== this.runGen) {
      return false;
    }
    if (summary.length === 0) {
      this.status = before;
      if (manual) {
        this.push('system', '压缩没做成:模型没回话。前面的对话照旧,太长时只发最近的部分。');
      }
      this.changed();
      return false;
    }
    const fresh = await sessionStore.get(this.context, this.sessionId);
    if (!fresh) {
      return false;
    }
    const marker = new LocalChatMessage();
    marker.role = 'system';
    marker.kind = 'summary';
    marker.text = summary;
    marker.count = at - (start + 1);
    // 等摘要期间只可能在末尾追加,分界位置不变。
    fresh.messages = fresh.messages.slice(0, at).concat([marker]).concat(fresh.messages.slice(at));
    await sessionStore.replaceMessages(this.context, fresh);
    this.lines = fresh.messages.slice();
    this.status = before;
    this.changed();
    return true;
  }

  /** 后台时间快用完:停下这一轮,回到前台自动接着跑(iOS 同样处理)。 */
  pauseForBackground(): void {
    if (!this.active) {
      return;
    }
    this.stop().then(() => {
      this.pausedByBackground = true;
      this.status = '在后台暂停了,回到前台会接着跑';
      this.changed();
      ChatRuns.settled(this, 'interrupted', '');
    });
  }

  resumeIfPaused(): void {
    if (this.pausedByBackground && !this.active) {
      this.resume(this.thinking);
    }
  }

  // ---- 一轮的流程 ----

  private async start(): Promise<void> {
    this.cancelRun();
    const gen = this.runGen;
    this.loopGuard = new ToolLoopGuard();
    this.interrupted = false;
    const bound = await sessionStore.get(this.context, this.sessionId);
    if (!bound || gen !== this.runGen) return;
    this.memoryEnabled = bound.memoryEnabled;
    if (bound.unresolvedModelId) {
      this.finish(gen, 'failed', `请先选择 AI 服务商中的模型（原模型 ${bound.unresolvedModelId}）`); return;
    }
    if (bound.modelGroupId) {
      const group = providerStore.groups.find((row: ModelGroup) => row.id === bound.modelGroupId);
      const queue = providerStore.queue(this.sessionId, bound.modelGroupId, false);
      if (!group || !queue.length) { this.finish(gen, 'failed', '这个对话绑定的模型组已不可用，请重新选择模型'); return; }
      if (queue.length > 0) {
        const different = JSON.stringify(queue) !== JSON.stringify(bound.modelQueue);
        if (different) await sessionStore.bindModels(this.context, this.sessionId, queue, bound.modelGroupId);
        if (gen !== this.runGen) return;
      }
    }
    if (bound.modelQueue.length === 0) {
      await sessionStore.bindModels(this.context, this.sessionId, providerStore.queue(this.sessionId), providerStore.activeGroupId);
      if (gen !== this.runGen) return;
    }
    if (!this.thinking && bound.modelGroupId) this.thinking = providerStore.groups.find((row: ModelGroup) => row.id === bound.modelGroupId)?.defaultThinkingLevel ?? '';
    try { this.modelQueue = providerStore.captureQueue(bound.modelQueue); }
    catch (error) { this.finish(gen, 'failed', (error as Error).message); return; }
    this.modelClients.clear();
    this.markActive();
    ChatRuns.askNotifications(this.context);
    await sessionStore.setRunning(this.context, this.sessionId, true).catch(() => {
      // 标记写不进去也照样跑,只是被杀后看不出没做完
    });
    let session = await sessionStore.get(this.context, this.sessionId);
    if (session && historyChars(textLines(session.messages)) > COMPACT_AT_CHARS) {
      await this.compact(false);
      if (gen !== this.runGen) {
        return;
      }
      this.status = '进行中';
      session = await sessionStore.get(this.context, this.sessionId);
    }
    if (!session) {
      this.finish(gen, 'failed', '这个对话不在了');
      return;
    }
    this.rounds = 0;
    this.failIndex = 0;
    this.loopTurns = conversationHistory(session.messages);
    this.startModel(gen);
  }

  private startModel(gen: number): void {
    this.beginModel(gen).catch((err: Error) => {
      this.finish(gen, 'failed', friendlyModelError(err.message));
    });
  }

  private async beginModel(gen: number): Promise<void> {
    this.stopStream();
    if (this.rounds >= MAX_TOOL_ROUNDS) {
      const text = `一次任务最多 ${MAX_TOOL_ROUNDS} 轮工具,已经停下`;
      this.push('system', text, 'error');
      this.finish(gen, 'failed', text);
      return;
    }
    this.rounds += 1;
    const queue = this.modelQueue;
    if (this.failIndex >= queue.length) {
      this.finish(gen, 'failed', '所有 AI 服务商都试过了,都没成功');
      return;
    }
    const slot = queue[this.failIndex];
    if (!providerStore.instances.some((row: ProviderInstance) => row.id === slot.instanceId && row.enabled)) {
      this.finish(gen, 'failed', '这个对话绑定的 AI 服务商已停用，请重新选择模型'); return;
    }
    this.actualModel = slot.model; this.actualProviderId = slot.instanceId; this.changed();
    const client = this.modelClients.get(this.failIndex) ?? await OpenAICompatClient.open(slot.root, slot.key, slot.model, slot.type,
      slot.credential, slot.instanceId, this.sessionId, slot.reference, slot.metadata);
    // 登录态刷新要走网络,这期间点了停止就不再开流。
    if (gen !== this.runGen) {
      return;
    }
    this.modelClients.set(this.failIndex, client);
    this.assistantOpen = false;
    this.streamBuf = '';
    this.streamDone = false;
    this.clearStreamTick();
    this.stream = client.streamTurn(this.loopTurns, LocalTools.systemPrompt(this.memoryAllowed()), this.thinking,
      (delta: string) => {
        if (gen !== this.runGen) {
          return;
        }
        this.appendAssistant(delta);
      }, (turn: StreamTurn) => {
        if (gen !== this.runGen) {
          return;
        }
        this.stream = null;
        this.streamDone = true;
        this.completeTurn(gen, turn).catch((error: Error) => {
          if (gen !== this.runGen) return;
          this.flushStream(); this.push('system', '回复保存失败，' + error.message, 'error'); this.finish(gen, 'failed', '回复保存失败');
        });
      }, (message: string) => {
        if (gen !== this.runGen) {
          return;
        }
        this.stream = null;
        this.flushStream();
        this.assistantOpen = false;
        const queue = this.modelQueue;
        if ((slot.fallbackAlways || shouldFailover(message)) && this.failIndex + 1 < queue.length) {
          this.dropPartialAssistant();
          this.failIndex += 1;
          this.rounds = Math.max(0, this.rounds - 1);
          this.push('system', `换到 ${queue[this.failIndex].model}`);
          this.startModel(gen);
          return;
        }
        const shown = friendlyModelError(message);
        this.push('system', shown, 'error');
        this.finish(gen, 'failed', shown);
      }, true, this.memoryAllowed(), () => gen === this.runGen);
  }

  private async completeTurn(gen: number, turn: StreamTurn): Promise<void> {
    const images: ChatImage[] = []; const deadline = Date.now() + 120000;
    for (const candidate of turn.images ?? []) {
      if (gen !== this.runGen) return;
      const saved = await GeneratedMedia.save(this.context, candidate, () => gen === this.runGen, deadline);
      if (gen !== this.runGen) return;
      if (images.some((media: ChatImage) => media.contentHash === saved.contentHash)) continue;
      const media = new ChatImage(); media.path = saved.path; media.mime = saved.mime; media.width = saved.width; media.height = saved.height;
      media.sourceId = saved.sourceId; media.contentHash = saved.contentHash; media.generated = true;
      const file = fileIo.openSync(saved.path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      try {
        const bytes = new ArrayBuffer(fileIo.statSync(file.fd).size);
        if (fileIo.readSync(file.fd, bytes) !== bytes.byteLength) throw new Error('生成图片读取不完整');
        media.b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(bytes));
      } finally { fileIo.closeSync(file); }
      images.push(media);
    }
    if (gen !== this.runGen) return;
    this.flushStream();
    const text = turn.text || (images.length ? '已生成图片' : '');
    if (text && !this.assistantOpen) { this.push('assistant', text); this.assistantOpen = true; }
    if (images.length) {
      const last = this.lines[this.lines.length - 1];
      if (last && last.role === 'assistant') { last.images = images; last.imagePath = images[0].path; last.imageMime = images[0].mime; last.imageB64 = images[0].b64; this.lines = this.lines.slice(); this.changed(); }
    }
    this.assistantOpen = false;
    const line = new LocalChatMessage(); line.role = 'assistant'; line.text = text; line.images = images;
    if (text || images.length) await sessionStore.appendLine(this.context, this.sessionId, line, () => gen === this.runGen);
    if (gen !== this.runGen) return;
    usageStore.add(this.context, turn.promptTokens, turn.completionTokens).catch(() => {});
    if (turn.calls.length) {
      const assistant = new LoopTurn(); assistant.role = 'assistant'; assistant.content = text; assistant.calls = turn.calls; assistant.images = images;
      this.loopTurns = this.loopTurns.concat([assistant]); this.push('system', toolPlanLine(turn.calls.map((call: ToolCall) => call.name)));
      await sessionStore.append(this.context, this.sessionId, 'system', toolPlanLine(turn.calls.map((call: ToolCall) => call.name)));
      if (gen === this.runGen) await this.runTools(gen, turn.calls);
    } else this.finish(gen, 'done', text);
  }

  private continueTools(): void {
    if (this.pendingCalls.length > 0) {
      this.markActive();
      this.runTools(this.runGen, this.pendingCalls.slice());
    }
  }

  private markActive(): void {
    this.active = true;
    this.status = '进行中';
    taskStatus.setRunning(true, this.sessionId);
    this.changed();
  }

  private async runTools(gen: number, calls: ToolCall[]): Promise<void> {
    this.pendingCalls = [];
    for (let i = 0; i < calls.length; i++) {
      if (gen !== this.runGen) {
        return;
      }
      const call = calls[i];
      const prior = this.approvalCall;
      const matching = this.approvalGeneration === gen && prior && prior.id === call.id && prior.name === call.name && prior.args === call.args;
      SensitiveToolGate.beginOperation(this.sessionId, matching ? this.approvalTicket : util.generateRandomUUID(), call.name, call.args);
      const result: ToolResult = await LocalTools.run(this.context, call.name, call.args, this.sessionId, false, () => gen === this.runGen, () => this.memoryAllowed());
      if (gen !== this.runGen) {
        return;
      }
      if (result.needWrite) {
        this.askWrite = true;
        this.active = false;
        taskStatus.setPendingWrite(true, this.sessionId);
        taskStatus.setRunning(false, this.sessionId);
        this.pendingCalls = calls.slice(i).map((item: ToolCall) => { const copy = new ToolCall(); copy.id = item.id; copy.name = item.name; copy.args = item.args; return copy; });
        this.freezeApproval(this.pendingCalls[0], gen);
        this.status = '等待写文件';
        this.changed();
        ChatRuns.settled(this, 'approval', '');
        return;
      }
      this.clearApproval();
      const times = this.loopGuard.note(call.name, call.args);
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = call.id.length > 0 ? call.id : `call_${i}`;
      tool.toolName = call.name;
      tool.content = times >= LOOP_WARN_AT ? result.text + loopWarning(call.name, times) : result.text;
      tool.imageB64 = result.imageB64;
      tool.imageMime = result.imageMime;
      this.loopTurns = this.loopTurns.concat([tool]);
      const row = toolResultLine(call.name, result.text, result.title);
      this.push('system', row);
      sessionStore.append(this.context, this.sessionId, 'system', row).catch(() => {
        // 存档写不进去也接着跑
      });
      if (times >= LOOP_STOP_AT) {
        const text = `${call.name} 用同样的参数调用了 ${times} 次,已经停下`;
        this.push('system', text, 'error');
        this.cancelRun();
        this.finishNow('failed', text);
        return;
      }
    }
    if (gen === this.runGen) {
      this.startModel(gen);
    }
  }

  private finish(gen: number, outcome: string, text: string): void {
    if (gen !== this.runGen) {
      return;
    }
    this.finishNow(outcome, text);
  }

  private finishNow(outcome: string, text: string): void {

    this.active = false;
    taskStatus.setRunning(false, this.sessionId);
    sessionStore.setRunning(this.context, this.sessionId, false).catch(() => {
      // 下次打开时按最后一条判断
    });
    if (outcome === 'done') {
      this.status = '空闲';
      this.interrupted = false;
      this.maybeTitle().catch(() => {
        // 起不了标题就用原来的
      });
    } else {
      this.status = text;
      this.interrupted = true;
    }
    this.changed();
    ChatRuns.settled(this, outcome, text);
  }

  /** 作废正在跑的一轮,连同挂着的写文件审批。 */
  private cancelRun(): void {

    this.pendingNative = null; this.pendingNativeSubmission = ''; this.clearApproval();
    SubAgentTasks.cancelOwner(this.sessionId);
    this.runGen += 1;
    this.stopStream();
    this.askWrite = false;
    this.pendingCalls = [];
    taskStatus.setPendingWrite(false, this.sessionId);
  }

  private memoryAllowed(): boolean { return this.memoryEnabled && SessionStore.memoryAllowed(this.context, this.sessionId); }

  async setMemoryEnabled(enabled: boolean): Promise<void> {
    await sessionStore.setMemoryEnabled(this.context, this.sessionId, enabled);
    this.memoryEnabled = enabled; this.changed();
  }

  private async finishNative(text: string, spoken: string): Promise<void> {
    try {
      const user = new LocalChatMessage(); user.role = 'user'; user.text = text; user.submissionId = this.submissionId;
      await sessionStore.appendLine(this.context, this.sessionId, user);
      ChatViewState.admitted(this.sessionId, this.submissionId);
      this.push('user', text);
      await sessionStore.append(this.context, this.sessionId, 'assistant', spoken);
      this.push('assistant', spoken);
      await this.refreshTitle();
      this.status = '空闲';
      this.interrupted = false;
    } catch (err) {
      this.status = `${err}`;
    }
    this.changed();
  }

  private async runSlash(text: string): Promise<void> {
    const parts = text.split(' ');
    const cmd = parts[0];
    const rest = text.substring(cmd.length).trim();
    let out = '';
    try {
      if (cmd === '/ls') {
        out = LocalTools.listSandbox(this.context);
      } else if (cmd === '/read') {
        out = LocalTools.readSandbox(this.context, rest);
      } else if (cmd === '/write') {
        const space = rest.indexOf(' ');
        if (space < 0) {
          out = '用法：/write 文件名 内容';
        } else {
          const call = new ToolCall(); call.id = util.generateRandomUUID(); call.name = 'file_write';
          const args = new NativeWriteArgs(); args.path = rest.substring(0, space); args.text = rest.substring(space + 1); call.args = JSON.stringify(args);
          SensitiveToolGate.beginOperation(this.sessionId, util.generateRandomUUID(), call.name, call.args);
          const current = this.runGen;
          if (!await SensitiveToolGate.bindArguments(this.sessionId, call.name, call.args, () => current === this.runGen)) return;
          out = LocalTools.writeSandbox(this.context, args.path, args.text, this.sessionId);
          if (out === '__NEED_WRITE_GRANT__') {
            this.pendingNative = call; this.pendingNativeSubmission = this.submissionId; this.freezeApproval(call, this.runGen);
            this.askWrite = true; taskStatus.setPendingWrite(true, this.sessionId);
            out = '请检查下方完整内容后批准写入';
          }
        }
      } else if (cmd === '/memory') {
        await this.setMemoryEnabled(!this.memoryEnabled); out = this.memoryEnabled ? '已开启本会话记忆' : '已关闭本会话记忆';
      } else if (cmd === '/remember') {
        if (!this.memoryAllowed()) throw new Error('本会话已关闭记忆，请先用 /memory 开启');
        await memoryStore.load(this.context);
        await memoryStore.appendToday(this.context, rest);
        out = '已写入今日记忆';
      } else if (cmd === '/open') {
        out = LocalTools.openLink(rest, false, this.sessionId);
      } else if (cmd === '/auto') {
        await SensitiveToolGate.setFullAuto(this.context, !SensitiveToolGate.fullAuto);
        out = SensitiveToolGate.fullAuto ? '已切到全自动:写文件不再逐项确认。再发 /auto 切回。' :
          '已切回逐项确认:写文件前先问你。';
      } else if (cmd === '/compact') {
        out = await this.compact(true) ? '前面的对话已压缩成摘要,最近几轮原样留着' : '';
      } else {
        out = '本机命令：/ls /read /write /remember /open /auto /compact';
      }
    } catch (err) {
      out = `${err}`;
    }
    if (out.length > 0) {
      this.push('system', out);
      const result = new LocalChatMessage(); result.role = 'system'; result.text = out; result.submissionId = this.askWrite ? '' : this.submissionId;
      await sessionStore.appendLine(this.context, this.sessionId, result).then(() => {
        if (result.submissionId) ChatViewState.admitted(this.sessionId, result.submissionId);
      }).catch(() => {
        // 显示过了就行
      });
    }
    if (!this.active && !this.askWrite) {
      this.status = '空闲';
    }
    this.changed();
  }

  private async refreshTitle(): Promise<void> {
    const session = await sessionStore.get(this.context, this.sessionId);
    if (session && session.title !== this.title) {
      this.title = session.title;
      this.changed();
    }
  }

  /**
   * 第一轮说完后让模型起个标题(iOS 同一套提示词),最多试 3 次。
   * 只替换自动起的标题(「新任务」或第一句话截的),你改过名的不动。
   */
  private async maybeTitle(): Promise<void> {
    if (this.titleTries >= TITLE_ATTEMPTS) {
      return;
    }
    const session: LocalSession | null = await sessionStore.get(this.context, this.sessionId);
    if (!session) {
      return;
    }
    let firstUser = '';
    for (let i = 0; i < session.messages.length; i++) {
      if (session.messages[i].role === 'user' && session.messages[i].kind === '') {
        firstUser = session.messages[i].text;
        break;
      }
    }
    const before = session.title;
    if (before !== '新任务' && before !== titleFromPrompt(firstUser)) {
      return;
    }
    const excerpt = titleExcerpt(textLines(session.messages));
    if (excerpt.length === 0) {
      return;
    }
    this.titleTries += 1;
    const title = parseTitleReply(await SideModel.complete(this.context, TITLE_SYSTEM_PROMPT, titlePrompt(excerpt)));
    const now = await sessionStore.get(this.context, this.sessionId);
    if (title.length === 0 || !now || now.title !== before) {
      return;
    }
    await sessionStore.rename(this.context, this.sessionId, title);
    this.title = title;
    this.changed();
  }

  // ---- 吐字 ----

  private stopStream(): void {
    this.clearStreamTick();
    this.streamBuf = '';
    this.streamDone = false;
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.assistantOpen = false;
  }

  private appendAssistant(delta: string): void {
    if (!delta) {
      return;
    }
    this.streamBuf += delta;
    this.pumpStream();
  }

  private pumpStream(): void {
    if (this.streamTick >= 0) {
      return;
    }
    this.streamTick = setTimeout(() => {
      this.streamTick = -1;
      if (this.streamBuf.length === 0) {
        return;
      }
      const n = this.streamBuf.length > 120 ? 28 : Math.min(10, this.streamBuf.length);
      const take = this.streamBuf.substring(0, n);
      this.streamBuf = this.streamBuf.substring(n);
      this.paintDelta(take);
      if (this.streamBuf.length > 0 || this.streamDone) {
        this.pumpStream();
      }
    }, 16);
  }

  private flushStream(): void {
    this.clearStreamTick();
    if (this.streamBuf.length > 0) {
      this.paintDelta(this.streamBuf);
      this.streamBuf = '';
    }
    this.streamDone = false;
  }

  private clearStreamTick(): void {
    if (this.streamTick >= 0) {
      clearTimeout(this.streamTick);
      this.streamTick = -1;
    }
  }

  private paintDelta(delta: string): void {
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
    const next = new LocalChatMessage();
    next.role = last.role;
    next.text = last.text + delta;
    next.imageB64 = last.imageB64;
    next.imageMime = last.imageMime;
    next.imagePath = last.imagePath; next.images = last.images.slice();
    next.kind = last.kind;
    next.at = last.at;
    copy[copy.length - 1] = next;
    this.lines = copy;
    this.changed();
  }

  private dropPartialAssistant(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1].role === 'assistant') {
      this.lines = this.lines.slice(0, this.lines.length - 1);
    }
  }

  /** 只在页面上显示、不存档的一行(工具行和存档里同一格式;kind 为 error 的画成红色错误条)。 */
  private push(role: string, text: string, kind: string = ''): void {
    if (!text) {
      return;
    }
    const line = new LocalChatMessage();
    line.role = role;
    line.text = text;
    line.kind = kind;
    line.at = Date.now();
    this.lines = this.lines.concat([line]);
    this.changed();
  }

  private changed(): void {
    ChatRuns.bump();
  }
}

/**
 * 内存里的对话:在跑的都留着,空闲又没人看的最多留 6 个。
 * 也管 App 退到后台的那段宽限(短时任务)和说完后的通知。
 */
export class ChatRuns {
  private static runs: Map<string, ChatRun> = new Map();
  private static tick: number = 0;
  private static graceId: number = -1;
  static foreground: boolean = true;

  static open(context: common.UIAbilityContext, sessionId: string): ChatRun {
    let run = ChatRuns.runs.get(sessionId);
    if (!run) {
      ChatRuns.prune();
      run = new ChatRun(context, sessionId);
      ChatRuns.runs.set(sessionId, run);
    }
    return run;
  }

  static isActive(sessionId: string): boolean {
    const run = ChatRuns.runs.get(sessionId);
    return run !== undefined && (run.active || run.askWrite);
  }

  static activeIds(): string[] {
    const ids: string[] = [];
    ChatRuns.runs.forEach((run: ChatRun, id: string) => {
      if (run.active || run.askWrite) {
        ids.push(id);
      }
    });
    return ids;
  }

  static anyActive(): boolean {
    let busy = false;
    ChatRuns.runs.forEach((run: ChatRun) => {
      if (run.active) {
        busy = true;
      }
    });
    return busy;
  }

  static invalidateIdle(sessionId: string): void {
    const run = ChatRuns.runs.get(sessionId);
    if (run && !run.active && !run.askWrite) ChatRuns.runs.delete(sessionId);
  }

  /** 对话被删了:停下它在跑的一轮。 */
  static forget(sessionId: string): void {
    const run = ChatRuns.runs.get(sessionId);
    if (run) {
      run.stop();
      ChatRuns.runs.delete(sessionId);
    }
  }

  private static askedNotify: boolean = false;

  /** 第一次在本机跑任务时问一次通知权限:退到后台说完了要靠它提醒。 */
  static askNotifications(context: common.UIAbilityContext): void {
    if (ChatRuns.askedNotify) {
      return;
    }
    ChatRuns.askedNotify = true;
    notificationManager.isNotificationEnabled().then((on: boolean) => {
      if (!on) {
        return notificationManager.requestEnableNotification(context);
      }
      return;
    }).catch(() => {
      // 不给就不发通知
    });
  }

  static bump(): void {
    ChatRuns.tick += 1;
    AppStorage.setOrCreate('chatTick', ChatRuns.tick);
  }

  static onBackground(keepAlive: boolean): void {
    ChatRuns.foreground = false;
    if (keepAlive || ChatRuns.anyActive()) {
      ChatRuns.holdGrace();
    }
  }

  static onForeground(): void {
    ChatRuns.foreground = true;
    ChatRuns.releaseGrace();
    ChatRuns.runs.forEach((run: ChatRun) => {
      run.resumeIfPaused();
    });
  }

  /** 一轮收场:App 在后台就发通知(iOS、安卓都只在后台发),都停了就还掉后台宽限。 */
  static settled(run: ChatRun, outcome: string, text: string): void {
    if (!ChatRuns.foreground) {
      ChatRuns.notify(run.sessionId, doneNotice(outcome, run.title, text)).catch(() => {
        // 没开通知权限
      });
    }
    if (!ChatRuns.anyActive()) {
      ChatRuns.releaseGrace();
    }
  }

  /** 发一条点开就回到这个对话的通知。 */
  static async notify(sessionId: string, words: string[]): Promise<void> {
    const info: wantAgent.WantAgentInfo = {
      wants: [{ bundleName: PKG, abilityName: 'EntryAbility', parameters: { 'openSession': sessionId } }],
      operationType: wantAgent.OperationType.START_ABILITY,
      requestCode: hashOf(sessionId) % 100000,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    const agent: WantAgent = await wantAgent.getWantAgent(info);
    const req: notificationManager.NotificationRequest = {
      id: 200000 + hashOf(sessionId) % 100000,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: words[0],
          text: words[1]
        }
      },
      wantAgent: agent
    };
    await notificationManager.publish(req);
  }

  /**
   * 退到后台时还有一轮在跑:申请一段短时任务(系统一般给到约 3 分钟)。快用完时停下这一轮,
   * 回到前台自动接着跑。ponytail: 没用长时任务(要常驻通知、系统审计进度),真要跑十几分钟再加。
   */
  private static holdGrace(): void {
    if (ChatRuns.graceId >= 0) {
      return;
    }
    try {
      const info = backgroundTaskManager.requestSuspendDelay('本机 Agent 还在跑', () => {
        ChatRuns.runs.forEach((run: ChatRun) => {
          run.pauseForBackground();
        });
        ChatRuns.releaseGrace();
      });
      ChatRuns.graceId = info.requestId;
    } catch (_err) {
      // 申请不到就只能听系统的
    }
  }

  private static releaseGrace(): void {
    if (ChatRuns.graceId < 0) {
      return;
    }
    try {
      backgroundTaskManager.cancelSuspendDelay(ChatRuns.graceId);
    } catch (_err) {
      // 已经过期
    }
    ChatRuns.graceId = -1;
  }

  /** 在放进新的之前清,免得把刚打开、还没人看的那个清掉。 */
  private static prune(): void {
    if (ChatRuns.runs.size < 6) {
      return;
    }
    const idle: string[] = [];
    ChatRuns.runs.forEach((run: ChatRun, id: string) => {
      if (!run.active && !run.askWrite && run.viewers === 0) {
        idle.push(id);
      }
    });
    for (let i = 0; i < idle.length && ChatRuns.runs.size >= 6; i++) {
      ChatRuns.runs.delete(idle[i]);
    }
  }
}
