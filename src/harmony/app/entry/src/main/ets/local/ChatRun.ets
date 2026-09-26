import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { FastLocalActions } from './FastLocalActions';
import { LocalTools, ToolResult } from './LocalTools';
import { OpenAICompatClient, StreamTurn } from './OpenAICompatClient';
import { SensitiveToolGate } from './SensitiveToolGate';
import { SideModel } from './SideModel';
import {
  HISTORY_CHAR_BUDGET,
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
  toolArg,
  trimHistory
} from './LocalProtocol';
import {
  COMPACT_AT_CHARS,
  COMPACT_KEEP_USER_TURNS,
  COMPACT_SYSTEM_PROMPT,
  STOPPED_NOTE,
  TITLE_ATTEMPTS,
  TITLE_SYSTEM_PROMPT,
  TextLine,
  attachedFilesBlock,
  compactCut,
  compactTranscript,
  compactUserMessage,
  doneNotice,
  historyChars,
  lastSummaryIndex,
  parseTitleReply,
  resumeNote,
  summaryWrapper,
  titleExcerpt,
  titlePrompt,
  toolPlanLine,
  toolResultLine,
  unfinishedTail
} from './AgentText';
import { memoryStore } from '../store/MemoryStore';
import { providerStore } from '../store/ProviderStore';
import { LocalSession, sessionStore } from '../store/SessionStore';
import { taskStatus } from '../store/TaskStatus';
import { themeStore } from '../store/ThemeStore';
import { usageStore } from '../store/UsageStore';

const PKG = 'com.leoyuan.leophoneagent.harmony';

function texts(messages: LocalChatMessage[]): TextLine[] {
  return messages.map((row: LocalChatMessage) => {
    const line = new TextLine();
    line.role = row.role;
    line.text = row.text;
    line.kind = row.kind;
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
export class PendingImage {
  b64: string = '';
  mime: string = 'image/jpeg';
  path: string = '';
}

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
  private loopTurns: LoopTurn[] = [];
  private rounds: number = 0;
  private failIndex: number = 0;
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
    this.title = session.title;
    this.lines = session.messages.slice();
    this.interrupted = session.running || unfinishedTail(texts(session.messages));
    this.status = this.interrupted ? '上一轮没做完,可以点「继续」' : '空闲';
    this.changed();
  }

  /** 发一句话:先试本机快捷动作,斜杠命令走本机,其余交给模型。 */
  async send(text: string, image: PendingImage | null, files: string[], thinking: string): Promise<void> {
    this.thinking = thinking;
    if (text.length > 0 && files.length === 0) {
      const spoken = await FastLocalActions.tryRoute(this.context, text, image ? 1 : 0);
      if (spoken.length > 0) {
        await this.finishNative(text, spoken);
        return;
      }
    }
    if (!providerStore.configured()) {
      this.status = '未配置 AI 服务商';
      this.changed();
      return;
    }
    if (text.startsWith('/')) {
      await this.runSlash(text);
      return;
    }
    const line = new LocalChatMessage();
    line.role = 'user';
    line.text = (text.length > 0 ? text : (image ? '看这张图' : '看看这些文件')) + (image ? '\n[图片]' : '');
    if (image) {
      line.imageB64 = image.b64;
      line.imageMime = image.mime;
      line.imagePath = image.path;
    }
    line.files = files.slice();
    await sessionStore.appendLine(this.context, this.sessionId, line);
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
    const partial = this.assistantOpen || this.streamBuf.length > 0;
    this.flushStream();
    const last = this.lines.length > 0 ? this.lines[this.lines.length - 1] : null;
    this.cancelRun();
    this.active = false;
    taskStatus.setRunning(false);
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

  allowWrite(sessionWide: boolean): void {
    if (sessionWide) {
      SensitiveToolGate.grantSession(this.sessionId);
    } else {
      SensitiveToolGate.grantWriteOnce(this.sessionId);
    }
    this.askWrite = false;
    taskStatus.setPendingWrite(false);
    this.status = sessionWide ? '这个对话里写文件不再问' : '已允许这一次';
    this.continueTools();
  }

  denyWrite(stop: boolean): void {
    const calls = this.pendingCalls.slice();
    if (stop || calls.length === 0) {
      this.stop();
      return;
    }
    this.askWrite = false;
    this.pendingCalls = [];
    taskStatus.setPendingWrite(false);
    // 每个没执行的调用都要回一条结果,不然下一轮请求会因为「有调用没有结果」被服务商拒掉。
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = call.id.length > 0 ? call.id : `call_${i}`;
      tool.toolName = call.name;
      tool.content = (call.name === 'file_write' || call.name === 'file_edit') ?
        SensitiveToolGate.denialMessage(ChatRun.pathOf(call)) :
        '没有执行:前面的写文件被用户拒绝了。';
      this.loopTurns = this.loopTurns.concat([tool]);
    }
    this.push('system', '已拒绝写文件');
    this.markActive();
    this.startModel(this.runGen);
  }

  /** 刚切到全自动:正在等的这次写文件一并放行(Mac 端也是这么做的)。 */
  onFullAuto(): void {
    if (SensitiveToolGate.fullAuto && this.askWrite && this.pendingCalls.length > 0) {
      this.askWrite = false;
      taskStatus.setPendingWrite(false);
      this.continueTools();
    }
  }

  writeAskTitle(): string {
    const path = this.pendingCalls.length > 0 ? ChatRun.pathOf(this.pendingCalls[0]) : '';
    return path.length > 0 ? `要写文件:${path}` : '要写沙箱文件,等你确认';
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
    const all = texts(session.messages);
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
    this.markActive();
    ChatRuns.askNotifications(this.context);
    await sessionStore.setRunning(this.context, this.sessionId, true).catch(() => {
      // 标记写不进去也照样跑,只是被杀后看不出没做完
    });
    let session = await sessionStore.get(this.context, this.sessionId);
    if (session && historyChars(texts(session.messages)) > COMPACT_AT_CHARS) {
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
    this.loopTurns = this.historyTurns(session.messages);
    this.startModel(gen);
  }

  /** 发给模型的历史:从最后一个摘要之后开始,摘要包进第一句用户消息;附件清单、没说完的标记、继续都在这里换成模型看的话。 */
  private historyTurns(messages: LocalChatMessage[]): LoopTurn[] {
    const all = texts(messages);
    const start = lastSummaryIndex(all);
    const out: LoopTurn[] = [];
    for (let i = start + 1; i < messages.length; i++) {
      const line = messages[i];
      if (line.role !== 'user' && line.role !== 'assistant') {
        continue;
      }
      let content = line.text;
      if (line.kind === 'resume') {
        content = resumeNote(all, i);
      } else if (line.kind === 'partial') {
        content = `${line.text}\n\n${STOPPED_NOTE}`;
      }
      if (line.files.length > 0) {
        content = `${content}\n\n${attachedFilesBlock(line.files)}`;
      }
      // 同一角色连着两条(带工具的一轮里前后两段回答、失败后又发了一句)合成一条:有的服务商不收。
      const prev = out.length > 0 ? out[out.length - 1] : null;
      if (prev && prev.role === line.role && prev.imageB64.length === 0 && line.imageB64.length === 0) {
        prev.content = `${prev.content}\n\n${content}`;
        continue;
      }
      const turn = new LoopTurn();
      turn.role = line.role;
      turn.content = content;
      turn.imageB64 = line.imageB64;
      turn.imageMime = line.imageMime.length > 0 ? line.imageMime : 'image/jpeg';
      out.push(turn);
    }
    if (start >= 0) {
      const wrapped = summaryWrapper(messages[start].text);
      if (out.length > 0 && out[0].role === 'user') {
        out[0].content = `${wrapped}\n\n${out[0].content}`;
      } else {
        const head = new LoopTurn();
        head.role = 'user';
        head.content = wrapped;
        out.unshift(head);
      }
    }
    return trimHistory(out, HISTORY_CHAR_BUDGET);
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
      this.push('system', text);
      this.finish(gen, 'failed', text);
      return;
    }
    this.rounds += 1;
    const queue = providerStore.queue();
    if (this.failIndex >= queue.length) {
      this.finish(gen, 'failed', '所有 AI 服务商都试过了,都没成功');
      return;
    }
    const slot = queue[this.failIndex];
    const client = await OpenAICompatClient.open(providerStore.slotRoot(slot.instanceId),
      providerStore.keyFor(slot.instanceId), slot.model, providerStore.slotType(slot.instanceId),
      providerStore.slotCredential(slot.instanceId), slot.instanceId);
    // 登录态刷新要走网络,这期间点了停止就不再开流。
    if (gen !== this.runGen) {
      return;
    }
    this.assistantOpen = false;
    this.streamBuf = '';
    this.streamDone = false;
    this.clearStreamTick();
    this.stream = client.streamTurn(this.loopTurns, LocalTools.systemPrompt(), this.thinking,
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
        if (turn.calls.length > 0) {
          this.flushStream();
          this.assistantOpen = false;
          const assistant = new LoopTurn();
          assistant.role = 'assistant';
          assistant.content = turn.text;
          assistant.calls = turn.calls;
          this.loopTurns = this.loopTurns.concat([assistant]);
          if (turn.text.length === 0) {
            this.push('system', themeStore.toolPreview ? `工具 · ${turn.calls[0].name}` : '在用工具');
          }
          const calls = turn.calls;
          this.saveToolRound(turn.text, calls).then(() => {
            if (gen === this.runGen) {
              this.runTools(gen, calls);
            }
          });
          return;
        }
        this.persistAssistant(turn.text, turn.promptTokens, turn.completionTokens);
        this.finish(gen, 'done', turn.text);
      }, (message: string) => {
        if (gen !== this.runGen) {
          return;
        }
        this.stream = null;
        this.flushStream();
        this.assistantOpen = false;
        const queue = providerStore.queue();
        if (shouldFailover(message) && this.failIndex + 1 < queue.length) {
          this.dropPartialAssistant();
          this.failIndex += 1;
          this.rounds = Math.max(0, this.rounds - 1);
          this.push('system', `换到 ${queue[this.failIndex].model}`);
          this.startModel(gen);
          return;
        }
        const shown = friendlyModelError(message);
        this.push('system', shown);
        this.finish(gen, 'failed', shown);
      });
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
    taskStatus.setRunning(true);
    this.changed();
  }

  private async runTools(gen: number, calls: ToolCall[]): Promise<void> {
    this.pendingCalls = [];
    for (let i = 0; i < calls.length; i++) {
      if (gen !== this.runGen) {
        return;
      }
      const call = calls[i];
      const result: ToolResult = await LocalTools.run(this.context, call.name, call.args, this.sessionId);
      if (gen !== this.runGen) {
        return;
      }
      if (themeStore.toolPreview) {
        this.push('system', `工具 · ${result.title || call.name}`);
      }
      if (result.needWrite) {
        this.askWrite = true;
        this.active = false;
        taskStatus.setPendingWrite(true);
        taskStatus.setRunning(false);
        this.pendingCalls = calls.slice(i);
        this.status = '等待写文件';
        this.changed();
        ChatRuns.settled(this, 'approval', '');
        return;
      }
      const times = this.loopGuard.note(call.name, call.args);
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = call.id.length > 0 ? call.id : `call_${i}`;
      tool.toolName = call.name;
      tool.content = times >= LOOP_WARN_AT ? result.text + loopWarning(call.name, times) : result.text;
      tool.imageB64 = result.imageB64;
      tool.imageMime = result.imageMime;
      this.loopTurns = this.loopTurns.concat([tool]);
      this.push('system', result.text.length > 240 ? `${result.text.substring(0, 240)}…` : result.text);
      sessionStore.append(this.context, this.sessionId, 'system', toolResultLine(call.name, result.text)).catch(() => {
        // 存档写不进去也接着跑
      });
      if (times >= LOOP_STOP_AT) {
        const text = `${call.name} 用同样的参数调用了 ${times} 次,已经停下`;
        this.push('system', text);
        this.cancelRun();
        this.finishNow('failed', text);
        return;
      }
    }
    if (gen === this.runGen) {
      this.startModel(gen);
    }
  }

  /**
   * 工具执行前先把这一步存下来:模型这一步说的话,和要调用哪些工具。
   * App 在工具跑到一半被杀,重开时看得出哪一步没跑完(「继续」会告诉模型)。
   */
  private async saveToolRound(text: string, calls: ToolCall[]): Promise<void> {
    try {
      if (text.length > 0) {
        await sessionStore.append(this.context, this.sessionId, 'assistant', text);
      }
      await sessionStore.append(this.context, this.sessionId, 'system',
        toolPlanLine(calls.map((call: ToolCall) => call.name)));
    } catch (_err) {
      // 存档失败也接着跑
    }
  }

  private persistAssistant(output: string, prompt: number, completion: number): void {
    usageStore.add(this.context, prompt, completion).catch(() => {
      // keep chatting
    });
    if (!output) {
      return;
    }
    sessionStore.append(this.context, this.sessionId, 'assistant', output).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private finish(gen: number, outcome: string, text: string): void {
    if (gen !== this.runGen) {
      return;
    }
    this.finishNow(outcome, text);
  }

  private finishNow(outcome: string, text: string): void {
    this.active = false;
    taskStatus.setRunning(false);
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
    this.runGen += 1;
    this.stopStream();
    this.askWrite = false;
    this.pendingCalls = [];
    taskStatus.setPendingWrite(false);
  }

  private async finishNative(text: string, spoken: string): Promise<void> {
    try {
      await sessionStore.append(this.context, this.sessionId, 'user', text);
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
          out = LocalTools.writeSandbox(this.context, rest.substring(0, space), rest.substring(space + 1),
            this.sessionId);
          if (out === '__NEED_WRITE_GRANT__') {
            this.askWrite = true;
            out = '写文件要你先确认:点下面的「允许一次」或「本次会话允许」,再发一次 /write';
          }
        }
      } else if (cmd === '/remember') {
        await memoryStore.load(this.context);
        await memoryStore.appendToday(this.context, rest);
        out = '已写入今日记忆';
      } else if (cmd === '/open') {
        out = LocalTools.openLink(rest);
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
      await sessionStore.append(this.context, this.sessionId, 'system', out).catch(() => {
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
    const excerpt = titleExcerpt(texts(session.messages));
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
    next.imagePath = last.imagePath;
    copy[copy.length - 1] = next;
    this.lines = copy;
    this.changed();
  }

  private dropPartialAssistant(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1].role === 'assistant') {
      this.lines = this.lines.slice(0, this.lines.length - 1);
    }
  }

  private push(role: string, text: string): void {
    if (!text) {
      return;
    }
    const line = new LocalChatMessage();
    line.role = role;
    line.text = text;
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
