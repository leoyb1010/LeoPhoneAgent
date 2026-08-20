import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { applyActiveSwitchEnv } from '../leocodebox/index.js';

import {
  EVENT_APPROVAL_REQUEST,
  EVENT_APPROVAL_RESPONDED,
  EVENT_RUN_CANCELLED,
  EVENT_RUN_COMPLETED,
  EVENT_RUN_FAILED,
  EVENT_SESSION_CREATED,
  EVENT_TOOL_COMPLETED,
  EVENT_TOOL_STARTED,
  EVENT_USER_MESSAGE,
  createDialect,
  type HarnessDialect,
  type HarnessEvent,
} from './harness-dialects.js';
import { HARNESSES, resolveExecutable, type HarnessSpec } from './harness-specs.js';

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

export const LEOAGENT_HOME = (() => {
  const fromEnv = (process.env.LEOAGENT_HOME || '').trim();
  return fromEnv ? fromEnv.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.leoagent');
})();

const SESSIONS_DIR = path.join(LEOAGENT_HOME, 'harness-sessions');

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

export function setHarnessEventSink(sink: HarnessEventSink | null): void {
  eventSink = sink;
}

function pushHarnessEvent(event: Record<string, unknown>): void {
  eventSink?.(event);
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
  seq = 0;
  status = 'starting';
  // 按审批 id 存,不是单槽:CLI 可能在第一个审批未答复时抛出第二个,
  // 单槽会静默答错对象而让第一个永远等待。
  readonly pendingApprovals = new Map<string, HarnessEvent>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly toolNames = new Map<string, string>();
  private readonly dialect: HarnessDialect;
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(args: { sessionId: string; spec: HarnessSpec; cwd: string; logPath: string; seq?: number; status?: string }) {
    this.sessionId = args.sessionId;
    this.spec = args.spec;
    this.cwd = args.cwd;
    this.logPath = args.logPath;
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

    // 0600:日志携带 CLI 原样 stdout/stderr,可能包含它顺手打印的令牌。
    // 写失败只降级持久性,绝不能杀掉 stdout 泵——不抽的管道会永远堵死 CLI。
    try {
      if (!fs.existsSync(this.logPath)) {
        fs.writeFileSync(this.logPath, '', { mode: 0o600 });
      }
      fs.appendFileSync(this.logPath, `${JSON.stringify(enriched)}\n`);
    } catch {
      // ignore: durable log degraded, live stream continues
    }

    // [T-leophone-push] 关键事件外推给中继(手机没连着时的唯一触达路径)。
    // 放在持久化之后:推出去的必须是已经落盘、带 seq 与 approval_id 的
    // 富化帧,中继与手机才能按 seq 幂等合并。推送失败不影响本地流。
    if (PUSHABLE_EVENTS.has(String(enriched.event))) {
      try {
        pushHarnessEvent(enriched);
      } catch {
        // 外推是尽力而为,绝不能影响会话本身
      }
    }

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

  /** `afterSeq` 之后的全部事件——断线的手机借此精确追平,不缺不重。 */
  replay(afterSeq = 0): HarnessEvent[] {
    if (!fs.existsSync(this.logPath)) return [];
    const events: HarnessEvent[] = [];
    let content = '';
    try {
      content = fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return [];
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: HarnessEvent;
      try {
        event = JSON.parse(trimmed) as HarnessEvent;
      } catch {
        continue;
      }
      if (Number(event.seq ?? 0) > afterSeq) events.push(event);
    }
    return events;
  }

  /**
   * 回放后接实时,接缝处不丢不重:队列在读日志之前挂上(反过来会永久丢失
   * 回放期间产生的事件),回放已覆盖的实时事件按 seq 去重丢弃。
   */
  async *subscribe(afterSeq = 0): AsyncGenerator<HarnessEvent> {
    const sub: Subscriber = { queue: [], wake: null, closed: false };
    this.subscribers.add(sub);
    let highest = afterSeq;
    try {
      for (const event of this.replay(afterSeq)) {
        highest = Math.max(highest, Number(event.seq ?? 0));
        yield event;
      }
      // 已结束的会话没有实时可跟;不然客户端会白挂在队列上直到超时。
      if (TERMINAL_STATUSES.has(this.status)) return;
      while (true) {
        if (sub.queue.length === 0) {
          if (sub.closed) return;
          await new Promise<void>((resolve) => { sub.wake = resolve; });
          sub.wake = null;
          continue;
        }
        const event = sub.queue.shift()!;
        const seq = Number(event.seq ?? 0);
        if (seq <= highest) continue; // 回放已交付
        highest = seq;
        yield event;
        if ([EVENT_RUN_COMPLETED, EVENT_RUN_FAILED, EVENT_RUN_CANCELLED].includes(String(event.event))
          && ['completed', 'failed', 'cancelled'].includes(this.status)) {
          return;
        }
      }
    } finally {
      sub.closed = true;
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

    const proc = spawn(executable, this.spec.args.map((arg) => (
      arg.replaceAll('{cwd}', this.cwd).replaceAll('{prompt}', initialPrompt ?? '')
    )), {
      cwd: this.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
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

  /** 给运行中的会话追加指令。 */
  async send(text: string): Promise<void> {
    if (this.spec.promptInArgs) {
      throw new Error(`${this.spec.displayName} remote sessions are one-shot; start a new task to continue`);
    }
    if (!this.isLive || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.exitCode !== null) {
      throw new Error('session is not running');
    }
    const result = this.dialect.userMessage(text);
    if ('frames' in result) {
      this.writeFrames(result.frames);
    }
    // queued:会话 id 还没回来,方言已排队,id 一到由翻译层代发。
    if (this.status === 'idle') this.status = 'running';
    // 也进持久日志:不然对话的用户半边只存在于打字的那台设备上,
    // 重连回放出一份只有答案没有问题的转录。
    this.emit({ event: EVENT_USER_MESSAGE, text });
  }

  /**
   * 用 CLI 自己的方言答复一条具体的 pending 审批。只有答案真正到达 CLI 的
   * stdin 才返回 true;其余情况保持 pending——为一个没送到的答案报成功,
   * 会让客户端显示"已解决"而 CLI 永远阻塞。
   */
  async respondToApproval(choice: string, approvalId?: string | null): Promise<boolean> {
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
    const payload = this.dialect.approvalPayload(pending, choice);
    // 铸造的 id 客户端可寻址,但路由不回 CLI;假装可以只会清掉卡片而让
    // CLI 干等(approvalPayload 对缺 request_id 的 pending 返回 null)。
    if (payload == null) return false;
    this.writeFrames([payload]);
    this.emit({ event: EVENT_APPROVAL_RESPONDED, choice, approval_id: resolvedId });
    return true;
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
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }
    // 有清理逻辑的 CLI 可能无视 SIGTERM;不补刀的话状态写着 cancelled
    // 而进程永远跑下去。
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      proc.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /** 进程级兜底:daemon 收到终止信号时同步补刀,绝不留孤儿 CLI。 */
  killSync(): void {
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  summary(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: this.spec.key,
      name: this.spec.displayName,
      cwd: this.cwd,
      status: this.status,
      seq: this.seq,
      waiting_for_approval: this.pendingApprovals.size > 0,
      pending_approvals: [...this.pendingApprovals.entries()].map(([id, event]) => ({
        approval_id: id,
        command: event.command ?? '',
        choices: event.choices ?? [],
      })),
    };
  }
}

export class HarnessManager {
  readonly sessions = new Map<string, HarnessSession>();
  private readonly sessionsDir: string;

  constructor(sessionsDir = SESSIONS_DIR) {
    this.sessionsDir = sessionsDir;
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    try {
      // mkdir 只对叶子生效;父目录装着钥匙文件,必须显式收紧。
      fs.chmodSync(path.dirname(this.sessionsDir), 0o700);
      fs.chmodSync(this.sessionsDir, 0o700);
    } catch {
      // best effort
    }
    this.rehydrate();
  }

  /**
   * 从日志里以只读形式召回上一个进程周期的会话——包括 leoagent(Python)
   * 时代创建的:同一个目录、同一种日志格式。它们不能再被操控(进程已随旧
   * daemon 死去),但历史精确回放。
   */
  private rehydrate(): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.sessionsDir).filter((name) => name.startsWith('hs_') && name.endsWith('.ndjson')).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const logPath = path.join(this.sessionsDir, entry);
      const sessionId = entry.slice(0, -'.ndjson'.length);
      let harnessKey = '?';
      let cwd = '?';
      let lastSeq = 0;
      try {
        for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let event: HarnessEvent;
          try {
            event = JSON.parse(line) as HarnessEvent;
          } catch {
            continue;
          }
          lastSeq = Math.max(lastSeq, Number(event.seq ?? 0));
          if (event.event === EVENT_SESSION_CREATED) {
            harnessKey = String(event.harness ?? '?');
            cwd = String(event.cwd ?? '?');
          }
        }
      } catch {
        continue;
      }
      const spec = HARNESSES[harnessKey] ?? {
        key: harnessKey, displayName: harnessKey, executable: '', args: [], dialect: 'claude_stream_json' as const,
      };
      this.sessions.set(sessionId, new HarnessSession({
        sessionId, spec, cwd, logPath, seq: lastSeq, status: 'orphaned',
      }));
    }
  }

  private liveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isLive) count += 1;
    }
    return count;
  }

  async create(args: { harness: string; cwd: string; prompt?: string | null }): Promise<HarnessSession> {
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

    const sessionId = `hs_${crypto.randomBytes(16).toString('hex')}`;
    const session = new HarnessSession({
      sessionId, spec, cwd: workDir,
      logPath: path.join(this.sessionsDir, `${sessionId}.ndjson`),
    });
    // 日志第一行为会话命名,召回的会话才知道自己是谁。注册只在成功启动
    // 之后:spawn 失败绝不能留下永久的僵尸条目。
    session.emit({ event: EVENT_SESSION_CREATED, harness: spec.key, name: spec.displayName, cwd: workDir });
    try {
      if (args.prompt && spec.promptInArgs) session.emit({ event: EVENT_USER_MESSAGE, text: args.prompt });
      await session.start(args.prompt);
      if (args.prompt && !spec.promptInArgs) await session.send(args.prompt);
    } catch (error) {
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

  get(sessionId: string): HarnessSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Array<Record<string, unknown>> {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  /** daemon 退出前收割全部子进程;孤儿 CLI 会永远占着工作目录。 */
  async shutdownAll(): Promise<void> {
    const live = [...this.sessions.values()].filter((session) => session.isLive);
    await Promise.allSettled(live.map((session) => session.stop()));
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
