import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { applyActiveSwitchEnv, exactWindows } from '../leocodebox/index.js';

import {
  EVENT_APPROVAL_REQUEST,
  EVENT_APPROVAL_RESPONDED,
  EVENT_RUN_CANCELLED,
  EVENT_RUN_COMPLETED,
  EVENT_RUN_FAILED,
  EVENT_SESSION_CREATED,
  EVENT_TOOL_COMPLETED,
  EVENT_TOOL_DELTA,
  EVENT_TOOL_STARTED,
  EVENT_USER_MESSAGE,
  createDialect,
  normalizeThinkingLevelFrame,
  piTurnCommandType,
  type HarnessDialect,
  type HarnessEvent,
} from './harness-dialects.js';
import { HarnessJournal, type JournalHealth, type JournalOptions } from './harness-journal.js';
import { HARNESSES, resolveExecutable, type HarnessLaunchContext, type HarnessModel, type HarnessSpec } from './harness-specs.js';
import { LEOAGENT_HOME } from './leoagent-home.js';
import { clipDenyReason, findPiSessionFile, hasAnyPiAuth, normalizePolicy, piSessionResumable, writeDenyReason, writePolicy, type ApprovalPolicy } from './pi-runtime.js';
import { applyOutgoingRules, readCwdRuleSidecar, writeCwdRuleSidecar } from './session-cwd-rule.js';
import { lastPromptSeq, rewindPiLastUser } from './session-rewind.js';
import { readRuleSidecar, writeRuleSidecar } from './session-rule.js';
import { clipSessionTitle, readTitleSidecar, writeTitleSidecar } from './session-title.js';

// LeoPhoneAgent harness 会话宿主——leoagent(Python)HarnessManager/HarnessSession
// 的 TS 移植,跑在 leocodebox 服务进程里。三条设计约束原样保留:
//
// 1. 一套事件词汇表(翻译在 harness-dialects.ts);
// 2. 事件持久化:NDJSON + 单调 seq,先写日志再扇出,?after=N 回放与实时
//    订阅字节一致;
// 3. 审批一等公民。
//
// 相对原版的一处升级:claude/codex 会话的子进程环境经过 Leoapi 的
// applyActiveSwitchEnv——手机发起的会话自动跟随当前激活节点与故障转移。

export { LEOAGENT_HOME };

const SESSIONS_DIR = path.join(LEOAGENT_HOME, 'harness-sessions');

function moveSessionSidecars(fromLog: string, toLog: string): void {
  for (const ext of ['.title', '.rule']) {
    const from = fromLog.replace(/\.ndjson$/i, ext);
    const to = toLog.replace(/\.ndjson$/i, ext);
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // sidecar is optional
    }
  }
}

function sanitizeForgottenId(raw: string): string {
  const id = raw.trim();
  if (!/^hs_[A-Za-z0-9_-]+$/.test(id)) throw new HarnessRequestError('会话不合法');
  return id;
}

/**
 * [T-leophone-push] 值得推给手机的事件。
 *
 * 只推"有行动价值"的:审批要人拍板,终态要人知道结果。
 * message.delta 这类进度帧量大且无行动价值,推了只会烧配额、刷屏。
 */
const PUSHABLE_EVENTS = new Set([
  'approval.request',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/**
 * 外推回调。由 relay-client 在启动时注册 —— 用回调而不是直接 import,
 * 是为了避开 session ↔ relay-client 的循环依赖(relay-client 要调
 * session 的 HTTP 面,session 又要推给 relay-client)。
 */
type HarnessEventSink = (event: Record<string, unknown>) => void;
let eventSink: HarnessEventSink | null = null;
/** 除中继之外的外推者(Telegram 等通道)。一个坏掉不影响其余。 */
const extraSinks = new Set<HarnessEventSink>();

export function setHarnessEventSink(sink: HarnessEventSink | null): void {
  eventSink = sink;
}

export function addHarnessEventSink(sink: HarnessEventSink): () => void {
  extraSinks.add(sink);
  return () => { extraSinks.delete(sink); };
}

function pushHarnessEvent(event: Record<string, unknown>): void {
  try { eventSink?.(event); } catch { /* 一个外推者出错不影响其余 */ }
  for (const sink of extraSinks) {
    try { sink(event); } catch { /* same */ }
  }
}
const MAX_LIVE_SESSIONS = 16;
/** 进程仍在、可续聊或可审批。`idle` 是 stream-json 回合结束后的活会话,不是终态。 */
export const LIVE_HARNESS_STATUSES = ['starting', 'running', 'idle', 'waiting_for_approval'] as const;
const LIVE_STATUSES = new Set<string>(LIVE_HARNESS_STATUSES);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

export function isLiveHarnessStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

function expandUser(input: string): string {
  return input.replace(/^~(?=$|\/)/, os.homedir());
}

type Subscriber = { queue: HarnessEvent[]; wake: (() => void) | null; closed: boolean };

export class HarnessSession {
  readonly sessionId: string;
  readonly spec: HarnessSpec;
  readonly cwd: string;
  readonly logPath: string;
  /** 2.0 内核会话的模型与审批策略;旧 CLI 会话为 null / default。 */
  model: HarnessModel | null = null;
  policy: ApprovalPolicy = 'default';
  /** 首条用户消息裁成标题;各端列表靠它认人。 */
  title = '';
  /** 这条会话自己的规矩,每轮 prompt/steer/follow_up 发给内核时带着。 */
  rule = '';
  /** 这个目录的规矩,同一 cwd 新开的会话也会带着。 */
  cwdRule = '';
  /** 最后一件有行动价值的事(用户说话 / 工具开跑 / 待批 / 终态),供列表一行摘要。 */
  lastEvent: Record<string, unknown> | null = null;
  createdAt = Date.now() / 1000;
  updatedAt = Date.now() / 1000;
  seq = 0;
  status = 'starting';
  // 按审批 id 存,不是单槽:CLI 可能在第一个审批未答复时抛出第二个,
  // 单槽会静默答错对象而让第一个永远等待。
  readonly pendingApprovals = new Map<string, HarnessEvent>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly toolNames = new Map<string, string>();
  private readonly dialect: HarnessDialect;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private promptTurns = 0;
  private resumeSession: string | null = null;
  private readonly journal: HarnessJournal;

  constructor(args: { sessionId: string; spec: HarnessSpec; cwd: string; logPath: string; model?: HarnessModel | null; policy?: string; seq?: number; status?: string; journalOptions?: JournalOptions; journal?: HarnessJournal }) {
    this.sessionId = args.sessionId;
    this.spec = args.spec;
    this.cwd = args.cwd;
    this.logPath = args.logPath;
    this.model = args.model ?? null;
    this.policy = normalizePolicy(args.policy);
    this.rule = readRuleSidecar(args.logPath);
    this.cwdRule = readCwdRuleSidecar(args.cwd);
    this.journal = args.journal ?? new HarnessJournal(args.logPath, {
      ...args.journalOptions,
      onCommitted: (event) => {
        if (PUSHABLE_EVENTS.has(event.event)) {
          try { pushHarnessEvent(event); } catch { /* delivery does not control persistence */ }
        }
        args.journalOptions?.onCommitted?.(event);
      },
      onStateChanged: () => {
        for (const sub of this.subscribers) sub.wake?.();
        args.journalOptions?.onStateChanged?.();
      },
    });
    if (args.seq != null) this.seq = args.seq;
    if (args.status) this.status = args.status;
    this.dialect = createDialect(args.spec.dialect, args.cwd);
  }

  get isLive(): boolean {
    return LIVE_STATUSES.has(this.status);
  }

  // -- event fan-out -------------------------------------------------------

  /**
   * 富化 → 追加持久日志 → 扇出给实时订阅者。所有富化必须发生在写日志之前:
   * 日志是重连客户端回放的内容,回放与实时不一致就毁掉了这个类存在的唯一
   * 保证(approval_id 曾在写后铸造,回放出的审批无法寻址)。
   */
  emit(event: HarnessEvent): void {
    if (event.event === EVENT_TOOL_DELTA) {
      const live: HarnessEvent = {
        ...event,
        session_id: this.sessionId,
        timestamp: Date.now() / 1000,
        ephemeral: true,
      };
      for (const sub of [...this.subscribers]) {
        const last = sub.queue[sub.queue.length - 1];
        if (last?.event === EVENT_TOOL_DELTA && last.tool_use_id === live.tool_use_id) {
          sub.queue[sub.queue.length - 1] = live;
        } else if (sub.queue.length >= 512) {
          sub.closed = true;
          this.subscribers.delete(sub);
          sub.wake?.();
          continue;
        } else {
          sub.queue.push(live);
        }
        sub.wake?.();
      }
      return;
    }
    this.seq += 1;
    const enriched: HarnessEvent = { ...event, seq: this.seq, session_id: this.sessionId, timestamp: Date.now() / 1000 };

    const name = enriched.event;
    if (name === EVENT_TOOL_STARTED) {
      const toolUseId = enriched.tool_use_id;
      if (toolUseId != null && toolUseId !== '') {
        this.toolNames.set(String(toolUseId), String(enriched.tool || 'tool'));
      }
    } else if (name === EVENT_TOOL_COMPLETED) {
      // 带上开始事件的同名工具名;客户端靠它闭合"运行中"的卡片。
      const toolUseId = enriched.tool_use_id;
      const tool = enriched.tool;
      if (toolUseId != null && toolUseId !== '' && (tool == null || tool === '' || tool === 'tool')) {
        const key = String(toolUseId);
        enriched.tool = this.toolNames.get(key) ?? 'tool';
        this.toolNames.delete(key);
      }
    } else if (name === EVENT_APPROVAL_REQUEST) {
      // CLI 没给 id 就铸一个,让每个请求都可寻址。
      const approvalId = String(enriched.request_id ?? `ap_${crypto.randomBytes(16).toString('hex')}`);
      enriched.approval_id = approvalId;
      this.pendingApprovals.set(approvalId, enriched);
      this.status = 'waiting_for_approval';
    } else if (name === EVENT_APPROVAL_RESPONDED) {
      const answered = enriched.approval_id;
      if (answered != null) this.pendingApprovals.delete(String(answered));
      if (this.pendingApprovals.size === 0) this.status = 'running';
    } else if (name === EVENT_RUN_COMPLETED || name === EVENT_RUN_FAILED) {
      if (this.spec.promptInArgs) {
        this.status = name === EVENT_RUN_COMPLETED ? 'completed' : 'failed';
      } else {
        // stream-json 类 CLI 回合结束后进程仍活着——"空闲可继续",不是"会话
        // 结束"。终态只由进程退出与 stop() 设置。
        if (this.proc !== null && this.proc.exitCode === null && !['cancelled', 'completed', 'failed'].includes(this.status)) {
          this.status = 'idle';
        }
      }
    }

    this.updatedAt = Number(enriched.timestamp);
    if (name === EVENT_USER_MESSAGE) {
      const text = String(enriched.text ?? '').replace(/\s+/g, ' ').trim();
      if (!this.title) this.title = text.slice(0, 80);
      const mode = enriched.mode === 'steer' || enriched.steer === true
        ? 'steer'
        : enriched.mode === 'follow_up'
          ? 'follow_up'
          : 'prompt';
      this.lastEvent = { event: name, text: text.slice(0, 120), timestamp: enriched.timestamp, mode };
    } else if (name === EVENT_TOOL_STARTED) {
      this.lastEvent = { event: name, text: `${String(enriched.tool ?? 'tool')} ${String(enriched.preview ?? '').slice(0, 100)}`.trim(), timestamp: enriched.timestamp };
    } else if (name === EVENT_APPROVAL_REQUEST) {
      this.lastEvent = { event: name, text: String(enriched.command ?? '').slice(0, 120), timestamp: enriched.timestamp };
    } else if (name === 'session.compacting') {
      if (this.status !== 'waiting_for_approval') this.status = 'running';
      this.lastEvent = { event: name, text: '正在压缩上下文。', timestamp: enriched.timestamp };
    } else if (name === 'session.retrying') {
      if (this.status !== 'waiting_for_approval') this.status = 'running';
      this.lastEvent = {
        event: name,
        text: `过载，正在再试 ${String(enriched.attempt ?? '')}${enriched.max != null ? `/${String(enriched.max)}` : ''}`.trim(),
        timestamp: enriched.timestamp,
      };
    } else if (name === EVENT_RUN_COMPLETED || name === EVENT_RUN_FAILED || name === EVENT_RUN_CANCELLED) {
      this.lastEvent = { event: name, text: String(enriched.error ?? enriched.output ?? '').slice(0, 120), timestamp: enriched.timestamp };
    } else if (name === 'session.model') {
      // pi 的 set_model 成功回执:会话的模型属性跟着变,上下文不变。
      const provider = String(enriched.provider ?? '');
      const modelId = String(enriched.model_id ?? '');
      if (provider && modelId) this.model = { provider, modelId };
    } else if (name === 'session.title') {
      const next = clipSessionTitle(String(enriched.title ?? ''));
      if (next) this.title = next;
    }

    enriched.durability = this.journal.enqueue(enriched, PUSHABLE_EVENTS.has(name));

    for (const sub of [...this.subscribers]) {
      if (sub.queue.length >= 512) {
        // 卡死的订阅者被摘除而不是拖垮会话;它可以按 seq 从日志追上。
        sub.closed = true;
        this.subscribers.delete(sub);
        sub.wake?.();
        continue;
      }
      sub.queue.push(enriched);
      sub.wake?.();
    }
  }

  journalHealth(): JournalHealth { return this.journal.health(); }
  flushJournal(timeoutMs?: number): Promise<JournalHealth> { return this.journal.flush(timeoutMs); }
  closeJournal(timeoutMs?: number): Promise<JournalHealth> { return this.journal.close(timeoutMs); }
  replay(afterSeq = 0, signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
    return this.journal.replay(afterSeq, signal);
  }

  /** Register before replay; snapshot pending rows before any I/O can commit them. */
  async *subscribe(afterSeq = 0, options: { signal?: AbortSignal; journalStatus?: boolean } = {}): AsyncGenerator<HarnessEvent> {
    const sub: Subscriber = { queue: [], wake: null, closed: false };
    this.subscribers.add(sub);
    const pending = this.journal.pendingEvents(afterSeq);
    const abort = () => { sub.closed = true; sub.wake?.(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let highest = afterSeq;
    let lastHealth = '';
    try {
      for await (const event of this.replay(afterSeq, options.signal)) {
        highest = Math.max(highest, Number(event.seq ?? 0));
        yield event;
      }
      for (const event of pending) {
        if (Number(event.seq) <= highest) continue;
        highest = Number(event.seq);
        yield event;
      }
      while (!sub.closed && !options.signal?.aborted) {
        if (options.journalStatus) {
          const health = this.journal.health();
          const encoded = JSON.stringify(health);
          if (encoded !== lastHealth) {
            lastHealth = encoded;
            // Control frames have no seq: they never advance the event cursor.
            yield { event: 'journal.status', type: 'durability', session_id: this.sessionId, ...health };
          }
        }
        if (sub.queue.length) {
          const event = sub.queue.shift()!;
          const seq = Number(event.seq ?? 0);
          if (seq <= highest) continue;
          highest = seq;
          yield event;
          continue;
        }
        if (TERMINAL_STATUSES.has(this.status)) {
          if (options.journalStatus && this.journal.health().state === 'pending') {
            await this.journal.flush();
            const health = this.journal.health();
            yield { event: 'journal.status', type: 'durability', session_id: this.sessionId, ...health };
          }
          return;
        }
        await new Promise<void>((resolve) => { sub.wake = resolve; });
        sub.wake = null;
      }
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    } finally {
      sub.closed = true;
      options.signal?.removeEventListener('abort', abort);
      this.subscribers.delete(sub);
    }
  }

  // -- lifecycle -----------------------------------------------------------

  private writeFrames(frames: unknown[]): void {
    if (frames.length === 0) return;
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    for (const frame of frames) {
      stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }

  async start(initialPrompt?: string | null): Promise<void> {
    const executable = resolveExecutable(this.spec);
    if (!executable) {
      throw new Error(`${this.spec.displayName} is not installed on this machine`);
    }
    let env: Record<string, string | undefined> = { ...process.env };
    if (!env.TERM) env.TERM = 'dumb';
    // 钥匙守着这台 Mac 上的所有会话;被托管的 CLI 天生会跑任意 shell,
    // 把钥匙给它等于让任一会话驱动其他所有会话。
    delete env.LEOAGENT_KEY;
    // Leoapi:激活节点对手机发起的会话同样权威(与桌面会话同一条注入路径)。
    if (this.spec.switchTarget) {
      env = await applyActiveSwitchEnv(env, this.spec.switchTarget);
    }

    const launch = this.launchContext();
    if (this.spec.buildEnv) env = this.spec.buildEnv(env, launch);
    const argv = this.spec.buildArgs
      ? this.spec.buildArgs(launch)
      : this.spec.args.map((arg) => arg.replaceAll('{cwd}', this.cwd).replaceAll('{prompt}', initialPrompt ?? ''));
    const proc = spawn(executable, argv, {
      cwd: this.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成进程组。托管的 CLI 会自己拉 `npm test`、dev server 这类长命子进程;
      // 只 kill 组长的话它们全变孤儿继续跑(还继续占端口),而这边的状态早已
      // 写成 cancelled。detached + kill(-pid) 是同仓 electron/localServer.js
      // 收本机服务时用的同一套做法。
      detached: process.platform !== 'win32',
    });
    this.proc = proc;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      proc.once('error', onError);
      proc.once('spawn', () => {
        proc.off('error', onError);
        resolve();
      });
    });
    // spawn 后的运行期错误(EPIPE 等)不能变成未处理异常。
    proc.on('error', () => { /* surfaced via close */ });
    proc.stdin.on('error', () => { /* broken pipe: surfaced via close */ });

    this.status = 'running';

    const stdout = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.onStdoutLine(line));
    const stderr = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => {
      if (line.trim()) this.emit({ event: 'harness.stderr', text: line });
    });

    proc.on('close', (code) => this.onProcessClose(code));

    this.writeFrames(this.dialect.handshake());
    if (this.spec.promptInArgs) proc.stdin.end();
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 结构化通道上的非 JSON 通常是横幅或警告;呈现而不是隐藏。
      this.emit({ event: 'harness.stdout', text: line });
      return;
    }
    let events: HarnessEvent[];
    let outFrames: unknown[] = [];
    try {
      const result = this.dialect.translateLine(obj);
      events = result.events;
      outFrames = result.outFrames;
    } catch (error) {
      // 坏帧绝不能杀读循环:循环一死没人抽 stdout,管道塞满后 CLI 永远
      // 阻塞在 write() 上——会话挂死而状态还显示 running。
      events = [{
        event: 'harness.translate_error',
        text: `${error instanceof Error ? error.constructor.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`,
        raw: line.slice(0, 500),
      }];
    }
    for (const event of events) this.emit(event);
    // translator(同步)排的帧在这里代写:threadId 就绪后的排队输入、
    // 对不支持的 server 请求的拒绝响应。
    this.writeFrames(outFrames);
  }

  private onProcessClose(code: number | null): void {
    if (['completed', 'failed', 'cancelled'].includes(this.status)) return;
    if (code === 0) {
      this.status = 'completed';
      this.emit({ event: EVENT_RUN_COMPLETED, output: '', usage: {} });
    } else {
      this.status = 'failed';
      this.emit({ event: EVENT_RUN_FAILED, error: `exited with code ${code ?? -1}` });
    }
  }

  /**
   * 2.0 内核会话的原生命令通道(set_model / compact / abort / steer …)。只有活着的
   * pi 会话才收;回执经方言映射成 session.* 事件回到各端。
   */
  sendFrame(frame: unknown): boolean {
    if (this.spec.key !== 'pi') return false;
    if (!this.isLive || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.exitCode !== null) return false;
    const raw = frame && typeof frame === 'object' && !Array.isArray(frame)
      ? { ...(frame as Record<string, unknown>) }
      : null;
    if (!raw) return false;
    const outgoing = raw.type === 'set_thinking_level' ? normalizeThinkingLevelFrame(raw) : raw;
    if (outgoing.type === 'steer' || outgoing.type === 'follow_up') {
      const text = String(outgoing.message ?? '').trim();
      if (text) {
        outgoing.message = applyOutgoingRules(text, this.rule, readCwdRuleSidecar(this.cwd) || this.cwdRule);
        this.emit({ event: EVENT_USER_MESSAGE, text, mode: outgoing.type });
      }
    }
    if (outgoing.type === 'bash') {
      const command = String(outgoing.command ?? '').trim();
      if (!command) return false;
      outgoing.command = command;
      outgoing.id = String(outgoing.id ?? '').trim() || crypto.randomUUID();
      this.emit({
        event: EVENT_TOOL_STARTED,
        tool: 'bash',
        tool_use_id: outgoing.id,
        preview: command.slice(0, 400),
      });
    }
    this.writeFrames([outgoing]);
    if (outgoing.type === 'set_thinking_level') {
      const level = String(outgoing.level ?? '').trim();
      if (level) this.emit({ event: 'session.thinking', level });
    }
    if (outgoing.type === 'clear_queue') {
      this.emit({ event: 'session.queue_cleared' });
    }
    if (outgoing.type === 'abort') {
      this.pendingApprovals.clear();
      if (this.status === 'running' || this.status === 'starting' || this.status === 'waiting_for_approval') this.status = 'idle';
      this.emit({ event: 'session.aborted' });
    }
    return true;
  }

  /** 给运行中的会话追加指令。已经开过一轮且还在跑时走 steer,首句仍是 prompt。 */
  async send(text: string): Promise<void> {
    if (this.spec.promptInArgs) {
      throw new Error(`${this.spec.displayName} remote sessions are one-shot; start a new task to continue`);
    }
    if (!this.isLive || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.exitCode !== null) {
      throw new Error('session is not running');
    }
    if (this.spec.key === 'pi' && piTurnCommandType(this.status, this.promptTurns) === 'steer') {
      if (!this.sendFrame({ type: 'steer', message: text })) {
        throw new Error('session is not running');
      }
      return;
    }
    const result = this.dialect.userMessage(applyOutgoingRules(text, this.rule, readCwdRuleSidecar(this.cwd) || this.cwdRule));
    if ('frames' in result) {
      this.writeFrames(result.frames);
    }
    this.promptTurns += 1;
    // queued:会话 id 还没回来,方言已排队,id 一到由翻译层代发。
    if (this.status === 'idle') this.status = 'running';
    // 也进持久日志:不然对话的用户半边只存在于打字的那台设备上,
    // 重连回放出一份只有答案没有问题的转录。
    this.emit({ event: EVENT_USER_MESSAGE, text, mode: 'prompt' });
  }

  /**
   * 用 CLI 自己的方言答复一条具体的 pending 审批。只有答案真正到达 CLI 的
   * stdin 才返回 true;其余情况保持 pending——为一个没送到的答案报成功,
   * 会让客户端显示"已解决"而 CLI 永远阻塞。
   */
  async respondToApproval(choice: string, approvalId?: string | null, reason?: string): Promise<boolean> {
    let resolvedId = approvalId ?? null;
    let pending: HarnessEvent | undefined;
    if (resolvedId) {
      pending = this.pendingApprovals.get(resolvedId);
    } else if (this.pendingApprovals.size === 1) {
      const [first] = this.pendingApprovals.entries();
      resolvedId = first[0];
      pending = first[1];
    }
    if (!pending || !this.isLive || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    const why = choice === 'deny' ? clipDenyReason(reason ?? '') : '';
    if (choice === 'deny') writeDenyReason(this.sessionId, why);
    const payload = this.dialect.approvalPayload(pending, choice, why);
    // 铸造的 id 客户端可寻址,但路由不回 CLI;假装可以只会清掉卡片而让
    // CLI 干等(approvalPayload 对缺 request_id 的 pending 返回 null)。
    if (payload == null) return false;
    this.writeFrames([payload]);
    this.emit({ event: EVENT_APPROVAL_RESPONDED, choice, approval_id: resolvedId, ...(why ? { reason: why } : {}) });
    return true;
  }

  /**
   * 杀整个进程组,而不是只杀组长。
   *
   * CLI 自己会拉起 `npm test`、dev server 之类的长命子进程。旧实现只对
   * `this.proc.pid` 发信号,组长一走那些孙子进程就成了孤儿,继续跑、继续占端口,
   * 而这边的会话状态已经写成 cancelled —— 用户点了「停止」,机器上却什么都没停。
   * `spawn(..., { detached: true })` 让 pid 同时是组 id,这里用 `-pid` 一次收干净。
   */
  private killProcessGroup(signal: NodeJS.Signals): void {
    const proc = this.proc;
    if (!proc?.pid) return;
    if (process.platform === 'win32') {
      try {
        proc.kill(signal);
      } catch {
        // already gone
      }
      return;
    }
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // ESRCH:组已经没了;或者这个 pid 压根不是组长(win32 之外理论上不该
      // 发生,但别让它变成"漏杀")—— 退回单 pid 再来一次。
      try {
        proc.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  async stop(): Promise<void> {
    if (TERMINAL_STATUSES.has(this.status)) return;
    // 先落盘 cancelled 再等进程退出:否则这 5 秒窗口里 status 已是终态,
    // 新 SSE 订阅会回放完就关流,永远看不到 run.cancelled;同时 send/steer
    // 仍能写进正在被杀掉的 stdin。
    this.status = 'cancelled';
    this.emit({ event: EVENT_RUN_CANCELLED });
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    this.killProcessGroup('SIGTERM');
    // 有清理逻辑的 CLI 可能无视 SIGTERM;不补刀的话状态写着 cancelled
    // 而进程永远跑下去。
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      proc.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) this.killProcessGroup('SIGKILL');
  }

  /** 进程级兜底:daemon 收到终止信号时同步补刀,绝不留孤儿 CLI(含孙子进程)。 */
  killSync(): void {
    const proc = this.proc;
    if (proc && proc.exitCode === null) this.killProcessGroup('SIGTERM');
  }

  launchContext(): HarnessLaunchContext {
    return {
      sessionId: this.sessionId, cwd: this.cwd, home: LEOAGENT_HOME, model: this.model, policy: this.policy,
      ...(this.resumeSession ? { resumeSession: this.resumeSession } : {}),
    };
  }

  /**
   * 把已经结束/失联的本机 pi 会话再拉起来,走同一份内核 JSONL。
   * 没有对应文件就拒绝,绝不假装新开一条还叫续聊。
   */
  async continueWith(file: string): Promise<void> {
    if (this.isLive) throw new HarnessRequestError('session is still running');
    if (this.spec.key !== 'pi') throw new HarnessRequestError('只有本机 pi 会话能接着这条聊');
    if (this.proc && this.proc.exitCode === null) throw new HarnessRequestError('session is still running');
    this.resumeSession = file;
    this.pendingApprovals.clear();
    // 新拉起的进程还没开回合。promptTurns 若仍记着上一进程的轮次,
    // 第一句会走 steer,内核只入队、永远不开回合。
    this.promptTurns = 0;
    this.status = 'starting';
    this.emit({ event: 'session.resumed', cwd: this.cwd, path: file });
    await this.spec.prepare?.(this.launchContext());
    await this.start();
  }

  /**
   * 拿掉上一轮用户 prompt 及之后的工具/回复。活着的进程先停再按截过的
   * pi JSONL 拉起来,否则内核脑子里还留着那一轮。
   */
  async rewindLastTurn(): Promise<{ prompt: string }> {
    if (this.spec.key !== 'pi') throw new HarnessRequestError('只有本机 pi 会话能拿掉上一轮');
    if (this.status === 'starting' || this.status === 'running' || this.status === 'waiting_for_approval') {
      throw new HarnessRequestError('先停这一轮再拿掉');
    }
    const wasLive = this.isLive;
    if (wasLive) await this.stop();
    await this.journal.flush();
    const events: HarnessEvent[] = [];
    for await (const ev of this.journal.replay(0)) events.push(ev);
    const found = lastPromptSeq(events);
    if (!found.seq) throw new HarnessRequestError('没有上一轮');
    await this.journal.rewindBefore(found.seq);
    this.seq = this.journal.health().persisted_seq;
    this.pendingApprovals.clear();
    this.promptTurns = 0;
    const file = findPiSessionFile(this.sessionId, this.cwd, this.createdAt);
    if (file) rewindPiLastUser(file);
    this.emit({ event: 'session.rewound', text: found.prompt });
    if (wasLive) {
      const next = findPiSessionFile(this.sessionId, this.cwd, this.createdAt);
      if (next) await this.continueWith(next);
    }
    return { prompt: found.prompt };
  }

  /** 自己起的名字写进旁路文件,重启左栏还认得;事件流给正在看的端同步。 */
  setTitle(raw: string): string {
    const next = writeTitleSidecar(this.logPath, raw);
    this.title = next;
    this.emit({ event: 'session.title', title: next });
    return next;
  }

  /** 自己写下的规矩写进旁路文件,之后每轮发给内核时带着。空的就是去掉。 */
  setRule(raw: string): string {
    const next = writeRuleSidecar(this.logPath, raw);
    this.rule = next;
    this.emit({ event: 'session.rule', rule: next });
    return next;
  }

  /** 这个目录的规矩写在本机旁路文件,同一 cwd 的会话共享。空的就是去掉。 */
  setCwdRule(raw: string): string {
    const next = writeCwdRuleSidecar(this.cwd, raw);
    this.cwdRule = next;
    this.emit({ event: 'session.cwd_rule', cwd_rule: next });
    return next;
  }

  /** 改本会话的审批策略:落到策略文件(pi extension 每次工具调用都读),并写进日志让各端同步。 */
  setPolicy(input: unknown): ApprovalPolicy {
    this.policy = normalizePolicy(input);
    if (this.spec.key === 'pi') writePolicy(this.sessionId, this.policy);
    this.emit({ event: 'session.policy', policy: this.policy });
    return this.policy;
  }

  summary(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: this.spec.key,
      name: this.spec.displayName,
      cwd: this.cwd,
      status: this.status,
      model: this.model ? `${this.model.provider}/${this.model.modelId}` : null,
      policy: this.policy,
      title: this.title,
      rule: this.rule,
      cwd_rule: this.cwdRule || readCwdRuleSidecar(this.cwd),
      last_event: this.lastEvent,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      seq: this.seq,
      journal: this.journal.health(),
      window: exactWindows.summary(this.sessionId),
      waiting_for_approval: this.pendingApprovals.size > 0,
      pending_approvals: [...this.pendingApprovals.entries()].map(([id, event]) => ({
        approval_id: id,
        command: event.command ?? '',
        choices: event.choices ?? [],
      })),
      resumable: this.spec.key === 'pi' && !this.isLive && piSessionResumable(this.sessionId, this.cwd, this.createdAt),
    };
  }
}

export class HarnessManager {
  readonly sessions = new Map<string, HarnessSession>();
  private readonly sessionsDir: string;
  private readonly readyPromise: Promise<void>;
  private startupError: unknown;

  constructor(sessionsDir = SESSIONS_DIR) {
    this.sessionsDir = sessionsDir;
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    try {
      // mkdir 只对叶子生效;父目录装着钥匙文件,必须显式收紧。
      if (this.sessionsDir === SESSIONS_DIR) fs.chmodSync(path.dirname(this.sessionsDir), 0o700);
      fs.chmodSync(this.sessionsDir, 0o700);
    } catch {
      // best effort
    }
    this.readyPromise = this.rehydrate().catch((error) => { this.startupError = error; });
  }

  /**
   * 从日志里以只读形式召回上一个进程周期的会话——包括 leoagent(Python)
   * 时代创建的:同一个目录、同一种日志格式。它们不能再被操控(进程已随旧
   * daemon 死去),但历史精确回放。
   */
  async ready(): Promise<void> {
    await this.readyPromise;
    if (this.startupError) throw this.startupError;
  }

  private async rehydrate(): Promise<void> {
    const entries = (await fs.promises.readdir(this.sessionsDir))
      .filter((name) => name.startsWith('hs_') && name.endsWith('.ndjson')).sort();
    for (const entry of entries) await this.restoreFromLog(entry);
  }

  private async restoreFromLog(entry: string): Promise<HarnessSession> {
    const logPath = path.join(this.sessionsDir, entry);
    const journal = new HarnessJournal(logPath);
    await journal.initialize();
    const first = (await journal.readPage(0, { limit: 1 })).events[0];
    const harnessKey = first?.event === EVENT_SESSION_CREATED ? String(first.harness ?? '?') : '?';
    const cwd = first?.event === EVENT_SESSION_CREATED ? String(first.cwd ?? '?') : '?';
    const modelStr = first?.event === EVENT_SESSION_CREATED && typeof first.model === 'string' ? first.model : '';
    const slash = modelStr.indexOf('/');
    const model = slash > 0 ? { provider: modelStr.slice(0, slash), modelId: modelStr.slice(slash + 1) } : null;
    const policy = first?.event === EVENT_SESSION_CREATED && typeof first.policy === 'string' ? first.policy : undefined;
    const spec = HARNESSES[harnessKey] ?? {
      key: harnessKey, displayName: harnessKey, executable: '', args: [], dialect: 'claude_stream_json' as const,
    };
    const sessionId = entry.slice(0, -'.ndjson'.length);
    const restored = new HarnessSession({
      sessionId, spec, cwd, logPath, journal, model, policy, seq: journal.health().latest_seq, status: 'orphaned',
    });
    if (first?.timestamp != null) restored.createdAt = Number(first.timestamp);
    // 标题与最近一件事从日志头几行/尾行补回来,列表不至于全是空行。
    const named = readTitleSidecar(logPath);
    if (named) {
      restored.title = named;
    } else {
      const head = await journal.readPage(0, { limit: 8 });
      for (const ev of head.events) {
        if (ev.event === EVENT_USER_MESSAGE && ev.mode !== 'steer' && ev.mode !== 'follow_up') {
          restored.title = String(ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          break;
        }
      }
    }
    const latestSeq = journal.health().latest_seq;
    if (latestSeq > 0) {
      const tail = await journal.readPage(Math.max(0, latestSeq - 1), { limit: 1 });
      const lastEv = tail.events[tail.events.length - 1];
      if (lastEv?.timestamp != null) restored.updatedAt = Number(lastEv.timestamp);
      if (lastEv) {
        const mode = lastEv.mode === 'steer' || lastEv.mode === 'follow_up' || lastEv.mode === 'prompt' ? lastEv.mode : undefined;
        restored.lastEvent = {
          event: lastEv.event,
          text: String(lastEv.text ?? lastEv.command ?? lastEv.error ?? '').slice(0, 120),
          timestamp: lastEv.timestamp,
          ...(mode ? { mode } : {}),
        };
      }
    }
    this.sessions.set(sessionId, restored);
    return restored;
  }

  private liveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isLive) count += 1;
    }
    return count;
  }

  async create(args: { harness: string; cwd: string; prompt?: string | null; model?: HarnessModel | null; policy?: string }): Promise<HarnessSession> {
    await this.ready();
    const spec = HARNESSES[args.harness];
    if (!spec) throw new HarnessRequestError(`unknown harness: ${args.harness}`);
    if (!resolveExecutable(spec)) {
      throw new HarnessRequestError(`${spec.displayName} is not installed on this machine`);
    }
    if (spec.promptInArgs && !args.prompt?.trim()) {
      throw new HarnessRequestError(`${spec.displayName} requires a prompt`);
    }
    const workDir = expandUser(args.cwd);
    let isDir = false;
    try {
      isDir = fs.statSync(workDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new HarnessRequestError(`not a directory: ${args.cwd}`);
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
      throw new HarnessRequestError(`too many live sessions (max ${MAX_LIVE_SESSIONS})`);
    }
    if (spec.key === 'pi' && !hasAnyPiAuth()) {
      throw new HarnessRequestError('还没有登录任何模型。先去设置里授权或填密钥。');
    }

    const sessionId = `hs_${crypto.randomBytes(16).toString('hex')}`;
    const session = new HarnessSession({
      sessionId, spec, cwd: workDir,
      logPath: path.join(this.sessionsDir, `${sessionId}.ndjson`),
      model: spec.selectsModel ? (args.model ?? null) : null,
      policy: args.policy,
    });
    // 日志第一行为会话命名,召回的会话才知道自己是谁。注册只在成功启动
    // 之后:spawn 失败绝不能留下永久的僵尸条目。
    session.emit({
      event: EVENT_SESSION_CREATED, harness: spec.key, name: spec.displayName, cwd: workDir,
      model: session.model ? `${session.model.provider}/${session.model.modelId}` : null, policy: session.policy,
    });
    try {
      if (args.prompt && spec.promptInArgs) session.emit({ event: EVENT_USER_MESSAGE, text: args.prompt, mode: 'prompt' });
      await spec.prepare?.(session.launchContext());
      await session.start(args.prompt);
      if (args.prompt && !spec.promptInArgs) await session.send(args.prompt);
    } catch (error) {
      await session.closeJournal();
      try {
        fs.unlinkSync(session.logPath);
      } catch {
        // best effort
      }
      throw new HarnessRequestError(`failed to start ${spec.displayName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * 失联/结束后把同一条 pi 会话拉起来。没有内核记录就老实说,不新开。
   */
  async continue(sessionId: string): Promise<HarnessSession> {
    await this.ready();
    const session = this.sessions.get(sessionId);
    if (!session) throw new HarnessRequestError('No such session');
    if (session.isLive) throw new HarnessRequestError('session is still running');
    if (session.spec.key !== 'pi') throw new HarnessRequestError('只有本机 pi 会话能接着这条聊');
    if (!hasAnyPiAuth()) throw new HarnessRequestError('还没有登录任何模型。先去设置里授权或填密钥。');
    let isDir = false;
    try {
      isDir = fs.statSync(session.cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new HarnessRequestError(`not a directory: ${session.cwd}`);
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
      throw new HarnessRequestError(`too many live sessions (max ${MAX_LIVE_SESSIONS})`);
    }
    const file = findPiSessionFile(session.sessionId, session.cwd, session.createdAt);
    if (!file) throw new HarnessRequestError('这条会话没有可续的内核记录。只能在同一目录新开。');
    await session.continueWith(file);
    return session;
  }

  async rewind(sessionId: string): Promise<{ prompt: string }> {
    await this.ready();
    const session = this.sessions.get(sessionId);
    if (!session) throw new HarnessRequestError('No such session');
    return session.rewindLastTurn();
  }

  get(sessionId: string): HarnessSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Array<Record<string, unknown>> {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  talkLogs(): Array<{ sessionId: string; logPath: string }> {
    return [...this.sessions.values()].map((session) => ({ sessionId: session.sessionId, logPath: session.logPath }));
  }

  /**
   * 从左栏拿掉一条已经结束的会话:关日志、挪到 forgotten/,内存里删掉。
   * 进行中的必须先停。不删文件;重启不会自动召回,要主动找回来。
   */
  async forget(sessionId: string): Promise<{ forgotten: string }> {
    await this.ready();
    const session = this.sessions.get(sessionId);
    if (!session) throw new HarnessRequestError('No such session');
    if (session.isLive) throw new HarnessRequestError('session is still running');
    await session.closeJournal();
    const forgottenDir = path.join(this.sessionsDir, 'forgotten');
    fs.mkdirSync(forgottenDir, { recursive: true, mode: 0o700 });
    const dest = path.join(forgottenDir, path.basename(session.logPath));
    try {
      if (fs.existsSync(session.logPath)) fs.renameSync(session.logPath, dest);
      moveSessionSidecars(session.logPath, dest);
    } catch {
      // 文件已经不在也要把内存条目拿掉,否则左栏还挂着幽灵。
    }
    this.sessions.delete(sessionId);
    return { forgotten: dest };
  }

  async listForgotten(): Promise<Array<{ session_id: string; title: string; cwd: string; updated_at: number }>> {
    await this.ready();
    const dir = path.join(this.sessionsDir, 'forgotten');
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const out: Array<{ session_id: string; title: string; cwd: string; updated_at: number }> = [];
    for (const name of names.filter((entry) => entry.startsWith('hs_') && entry.endsWith('.ndjson')).slice(0, 40)) {
      const logPath = path.join(dir, name);
      const journal = new HarnessJournal(logPath);
      await journal.initialize();
      const sessionId = name.slice(0, -'.ndjson'.length);
      const titled = readTitleSidecar(logPath) || readTitleSidecar(path.join(this.sessionsDir, name));
      let title = titled;
      let cwd = '';
      let updated = 0;
      const head = await journal.readPage(0, { limit: 8 });
      const first = head.events[0];
      if (first?.event === EVENT_SESSION_CREATED) cwd = String(first.cwd ?? '');
      if (!title) {
        for (const ev of head.events) {
          if (ev.event === EVENT_USER_MESSAGE && ev.mode !== 'steer' && ev.mode !== 'follow_up') {
            title = String(ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
            break;
          }
        }
      }
      const latest = journal.health().latest_seq;
      if (latest > 0) {
        const tail = await journal.readPage(Math.max(0, latest - 1), { limit: 1 });
        updated = Number(tail.events.at(-1)?.timestamp ?? 0);
      }
      out.push({ session_id: sessionId, title: title || sessionId, cwd, updated_at: updated });
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  }

  async recall(sessionId: string): Promise<{ session_id: string; title: string }> {
    await this.ready();
    const id = sanitizeForgottenId(sessionId);
    if (this.sessions.has(id)) throw new HarnessRequestError('已经在左栏');
    const src = path.join(this.sessionsDir, 'forgotten', `${id}.ndjson`);
    const dest = path.join(this.sessionsDir, `${id}.ndjson`);
    if (!fs.existsSync(src)) throw new HarnessRequestError('没有这份拿掉的会话');
    fs.renameSync(src, dest);
    moveSessionSidecars(src, dest);
    const restored = await this.restoreFromLog(`${id}.ndjson`);
    return { session_id: restored.sessionId, title: restored.title };
  }

  /** 一次拿掉已经结束的会话。idle / 进行中不动。ids 有值时只收名单里的。 */
  async forgetEnded(ids?: readonly string[]): Promise<{ ids: string[] }> {
    await this.ready();
    const wanted = ids ? new Set(ids.filter(Boolean)) : null;
    const ended = [...this.sessions.values()].filter((session) => !session.isLive && (!wanted || wanted.has(session.sessionId)));
    const forgotten: string[] = [];
    for (const session of ended) {
      await this.forget(session.sessionId);
      forgotten.push(session.sessionId);
    }
    return { ids: forgotten };
  }

  /** 停掉正在跑或等审批的会话，idle / 终态不动。 */
  async haltBusy(): Promise<{ ids: string[] }> {
    await this.ready();
    const busy = [...this.sessions.values()].filter((session) => (
      session.status === 'starting' || session.status === 'running' || session.status === 'waiting_for_approval'
    ));
    await Promise.allSettled(busy.map((session) => session.stop()));
    return { ids: busy.map((session) => session.sessionId) };
  }

  /** daemon 退出前收割全部子进程;孤儿 CLI 会永远占着工作目录。 */
  async shutdownAll(): Promise<void> {
    await this.ready();
    const live = [...this.sessions.values()].filter((session) => session.isLive);
    await Promise.allSettled(live.map((session) => session.stop()));
    await Promise.allSettled([...this.sessions.values()].map((session) => session.closeJournal()));
  }

  killAllSync(): void {
    for (const session of this.sessions.values()) session.killSync();
  }
}

/** 客户端可修复的请求错误(→ HTTP 400),与服务器内部错误区分开。 */
export class HarnessRequestError extends Error {}

let managerInstance: HarnessManager | null = null;

export function getHarnessManager(): HarnessManager {
  if (!managerInstance) {
    managerInstance = new HarnessManager();
    // launchd/updater 的重启走 SIGTERM;不收割的话每个被托管的 CLI 都会
    // 变成脱管孤儿。异步 stop 尽力,exit 时同步补刀兜底。
    const reap = () => {
      const manager = managerInstance;
      if (manager) void manager.shutdownAll();
    };
    process.once('SIGTERM', reap);
    process.once('SIGINT', reap);
    process.once('exit', () => managerInstance?.killAllSync());
  }
  return managerInstance;
}
