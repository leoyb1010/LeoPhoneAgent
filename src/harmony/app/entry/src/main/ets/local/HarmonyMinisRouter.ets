import { common } from '@kit.AbilityKit';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { errorBody } from '../net/OutboundCodec';
import { LocalAgentEngine } from './LocalAgentEngine';
import { LocalTools } from './LocalTools';
import { sessionStore } from '../store/SessionStore';

/**
 * 中继 harness 协议版本，四端共用一个号。
 *
 * 这是**协议**版本，不是 App 版本 —— Mac 是 `leophone.routes.ts` 的
 * `const VERSION = '0.4.0'`，Android 是 `MinisHarnessRouter.PROTOCOL_VERSION = "0.4.0"`。
 * App 版本单独走 `app_version` 字段。之前这里两个字段都填了 ReleaseCatalog，
 * `version` 就变成了 `0.3.0-alpha.x`，跟另外三端对不上。
 */
export const PROTOCOL_VERSION: string = '0.4.0';

/**
 * 需要主动外推给中继的事件。与 Mac(`harness-session.service.ts` 的 PUSH 过滤)
 * 和 Android(`MinisHarnessRouter.PUSH_EVENTS`)保持一致：只推有行动价值的，
 * `message.delta` 这类进度事件量大且无价值，不推。
 *
 * 手机没挂着 SSE 时(切后台、被杀),这是唯一的触达路径 —— 中继据此留最近事件
 * 并发 APNs。少了这一条，鸿蒙身体跑完的任务在 iPhone 上就是石沉大海。
 */
const PUSH_EVENTS: string[] = ['approval.request', 'run.completed', 'run.failed', 'run.cancelled'];

/**
 * 会话表与事件表的上限。
 *
 * why:这台身体是长驻进程。iPhone 每开一个回合就往 `sessions` push 一条,而
 * `emit()` 每条 `message.delta` 又往 `row.events` 追加一条 —— 一轮长回答几百上千条。
 * 两个数组之前都没有任何回收路径,只增不减,跑久了就是一条确定的 OOM。
 * Android 的同形状问题已经确认会 OOM(见 `MinisHarnessRouter` 的 MAX_SESSIONS
 * 与 `MinisHarnessSession` 的环形缓冲),这里用同一组数字对齐。
 */
const MAX_SESSIONS: number = 64;
const MAX_RETAINED_EVENTS: number = 2000;
const MAX_RETAINED_CHARS: number = 2 * 1024 * 1024;
/** 事件信封(seq/session_id/timestamp)的固定开销。只为记账,不求精确。 */
const EVENT_OVERHEAD_CHARS: number = 96;
/** 这么久没产生过任何事件就算僵死,会话表打满时可以被回收(与 Android 一致)。 */
const STALE_SESSION_MS: number = 15 * 60 * 1000;
/** 终态会话优先淘汰。 */
const TERMINAL_STATUSES: string[] = ['idle', 'cancelled', 'completed', 'failed'];

export class RouterResult {
  status: number = 200;
  body: string = '{}';
  stream: boolean = false;
  sessionId: string = '';
  after: number = 0;
}

class BodySession {
  id: string = '';
  localId: string = '';
  status: string = 'idle';
  seq: number = 0;
  events: string[] = [];
  /**
   * 已被环形缓冲丢掉的最大 seq。
   * 不变式:`events[i]` 的 seq === evictedThrough + 1 + i —— replay() 靠它换算下标。
   */
  evictedThrough: number = 0;
  /** events 的粗略字符数。增量维护,免得每次裁剪都重新量一遍整张表。 */
  retainedChars: number = 0;
  /** 最后一次产生事件的时刻,僵死会话淘汰用。 */
  lastTouched: number = Date.now();
}

class LiveStream {
  streamId: string = '';
  sessionId: string = '';
}

export class HarmonyMinisRouter {
  private sessions: BodySession[] = [];
  private context: common.UIAbilityContext | null = null;
  private streams: Map<string, boolean> = new Map();
  private lives: LiveStream[] = [];
  private minted: number = 0;
  onLive: ((streamId: string, data: string) => void) | null = null;
  /** 关键事件外推(见 PUSH_EVENTS)。参数是已经带上 seq/session_id/timestamp 的整条事件 JSON。 */
  onPush: ((event: string) => void) | null = null;

  attach(context: common.UIAbilityContext): void {
    this.context = context;
  }

  handle(method: string, pathAndQuery: string, bodyText: string): RouterResult {
    const q = pathAndQuery.indexOf('?');
    const path = q >= 0 ? pathAndQuery.substring(0, q) : pathAndQuery;
    const query = q >= 0 ? pathAndQuery.substring(q + 1) : '';
    const verb = method.toUpperCase();
    if (verb === 'GET' && path === '/health') {
      return HarmonyMinisRouter.json(200,
        `{"status":"ok","platform":"harmony","version":${JSON.stringify(PROTOCOL_VERSION)},"server":"minis","app_version":${JSON.stringify(ReleaseCatalog.currentVersion)}}`);
    }
    if (verb === 'GET' && path === '/v1/capabilities') {
      // features 的七个键与 Mac(leophone.routes.ts)对齐,不支持的显式写 false
      // 而不是省略 —— Android 就是这么做的。省略在 iOS 上等价于 false
      // (LeoAgentClient `features[feature] == true`),但别的消费者未必。
      return HarmonyMinisRouter.json(200,
        `{"object":"leoagent.capabilities","platform":"harmony","version":${JSON.stringify(PROTOCOL_VERSION)},"server":"minis","app_version":${JSON.stringify(ReleaseCatalog.currentVersion)},"features":{"harness_sessions":true,"resumable_events":true,"approval_events":false,"session_steering":true,"session_digest":false,"task_receipts":false,"artifacts":false,"exact_window":false},"harnesses":[{"key":"minis","name":"LeoPhoneAgent"}]}`);
    }
    if (verb === 'GET' && path === '/harness/sessions') {
      return HarmonyMinisRouter.json(200, `{"sessions":[${this.summaries()}]}`);
    }
    if (verb === 'POST' && path === '/harness/sessions') {
      return this.create(bodyText);
    }
    const events = path.match(/^\/harness\/sessions\/([^/]+)\/events$/);
    if (verb === 'GET' && events) {
      let after = 0;
      const parts = query.split('&');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('after=')) {
          after = Number(parts[i].substring(6));
        }
      }
      return this.events(events[1], isNaN(after) ? 0 : after);
    }
    const send = path.match(/^\/harness\/sessions\/([^/]+)\/send$/);
    if (verb === 'POST' && send) {
      return this.send(send[1], bodyText);
    }
    const stop = path.match(/^\/harness\/sessions\/([^/]+)\/stop$/);
    if (verb === 'POST' && stop) {
      return this.stop(stop[1]);
    }
    const approval = path.match(/^\/harness\/sessions\/([^/]+)\/approval$/);
    if (verb === 'POST' && approval) {
      // 会话不存在是 404,会话在但没有待审批才是 409 —— 与 Mac
      // (leophone.routes.ts 先 404 再 409)和 Android 一致。之前一律 409,
      // iPhone 分不清"会话没了"和"这条审批已经被答过了"。
      if (!this.find(approval[1])) {
        return HarmonyMinisRouter.json(404, errorBody('No such session'));
      }
      return HarmonyMinisRouter.json(409, errorBody('No such pending approval'));
    }
    return HarmonyMinisRouter.json(404, errorBody('No such route'));
  }

  subscribe(streamId: string, sessionId: string): void {
    this.unsubscribe(streamId);
    const row = new LiveStream();
    row.streamId = streamId;
    row.sessionId = sessionId;
    this.lives = this.lives.concat([row]);
  }

  unsubscribe(streamId: string): void {
    const next: LiveStream[] = [];
    for (let i = 0; i < this.lives.length; i++) {
      if (this.lives[i].streamId !== streamId) {
        next.push(this.lives[i]);
      }
    }
    this.lives = next;
  }

  /**
   * 连接断了就把订阅全清 —— streamId 是中继给这条连接分配的,换了连接就作废。
   * 不清的话重连后还会往死 id 上推 stream_data(中继直接丢),订阅表只增不减。
   * Android 在 connectOnce 的 finally 里 cancelStreams(),Python 客户端同理。
   */
  clearStreams(): void {
    this.lives = [];
  }

  replay(sessionId: string, afterSeq: number): string[] {
    const row = this.find(sessionId);
    if (!row) {
      return [];
    }
    // 事件表被裁剪过之后下标不再等于 seq-1:events[i] 的 seq 是 evictedThrough + 1 + i。
    // 先把请求的 after 换算到当前数组的下标域,判断式仍然是"严格大于"——
    // 这是四端一致的补齐语义,不能因为加了环形缓冲就漂掉。
    const after = afterSeq - row.evictedThrough;
    const out: string[] = [];
    for (let i = 0; i < row.events.length; i++) {
      if (i + 1 > after) {
        out.push(row.events[i]);
      }
    }
    return out;
  }

  private create(bodyText: string): RouterResult {
    let prompt = '';
    let thinking = '';
    try {
      const obj = JSON.parse(bodyText.length > 0 ? bodyText : '{}') as Record<string, Object>;
      const harness = `${obj['harness'] ?? 'minis'}`;
      if (harness !== 'minis') {
        return HarmonyMinisRouter.json(400, errorBody(`unknown harness: ${harness}`));
      }
      prompt = `${obj['prompt'] ?? ''}`;
      thinking = `${obj['thinking'] ?? obj['effort'] ?? ''}`;
    } catch (_err) {
      return HarmonyMinisRouter.json(400, errorBody('bad json'));
    }
    if (this.sessions.length >= MAX_SESSIONS && !this.evictOne()) {
      return HarmonyMinisRouter.json(429, errorBody('too many active sessions'));
    }
    const row = new BodySession();
    // 只用 Date.now() 会在同一毫秒内建两个会话时撞 id —— find() 取第一个匹配,
    // 两条会话的事件就串了,stop 一条会连带取消另一条(LocalAgentEngine 按 id 分代)。
    this.minted += 1;
    row.id = `hs_${Date.now().toString(36)}${this.minted.toString(36)}`;
    row.status = prompt.length > 0 ? 'running' : 'idle';
    this.sessions.push(row);
    this.emit(row, `{"event":"session.created","harness":"minis","name":"LeoPhoneAgent","cwd":"~"}`);
    if (prompt.length > 0) {
      this.startTurn(row, prompt, thinking);
    }
    return HarmonyMinisRouter.json(202,
      `{"session_id":${JSON.stringify(row.id)},"harness":"minis","status":${JSON.stringify(row.status)}}`);
  }

  /**
   * 会话表满了时腾一个位置,腾不出来返回 false(调用方回 429)。
   *
   * 两级:先挑终态会话里最老的;都还在跑就挑"很久没有产生过任何事件"的僵死会话。
   * 真正在流式输出的会话每条 delta 都会刷新 lastTouched,不会被误伤。
   * why 要第二级:只淘汰终态的话,64 条全 running 时会变成永久 429 而且一条事件
   * 都不释放 —— 那正是 Android 踩过的 OOM 形状。
   */
  private evictOne(): boolean {
    let idx = -1;
    for (let i = 0; i < this.sessions.length; i++) {
      if (TERMINAL_STATUSES.indexOf(this.sessions[i].status) < 0) {
        continue;
      }
      if (idx < 0 || this.sessions[i].lastTouched < this.sessions[idx].lastTouched) {
        idx = i;
      }
    }
    if (idx < 0) {
      const now = Date.now();
      for (let i = 0; i < this.sessions.length; i++) {
        if (now - this.sessions[i].lastTouched < STALE_SESSION_MS) {
          continue;
        }
        if (idx < 0 || this.sessions[i].lastTouched < this.sessions[idx].lastTouched) {
          idx = i;
        }
      }
    }
    if (idx < 0) {
      return false;
    }
    const victimId = this.sessions[idx].id;
    // 在飞的回合先分代作废,再把 LocalAgentEngine 那两张按 sessionId 存的 Map
    // 里的死键清掉 —— 否则会话虽然没了,gen/reqs 仍然跟着 id 无限长。
    LocalAgentEngine.stop(victimId);
    LocalAgentEngine.forget(victimId);
    this.streams.delete(victimId);
    this.sessions.splice(idx, 1);
    return true;
  }

  private send(id: string, bodyText: string): RouterResult {
    const row = this.find(id);
    if (!row) {
      return HarmonyMinisRouter.json(404, errorBody('No such session'));
    }
    let text = '';
    let thinking = '';
    try {
      const obj = JSON.parse(bodyText.length > 0 ? bodyText : '{}') as Record<string, Object>;
      text = `${obj['text'] ?? ''}`;
      thinking = `${obj['thinking'] ?? obj['effort'] ?? ''}`;
    } catch (_err) {
      return HarmonyMinisRouter.json(400, errorBody('bad json'));
    }
    if (!text.trim()) {
      return HarmonyMinisRouter.json(400, errorBody('text is required'));
    }
    this.startTurn(row, text, thinking);
    return HarmonyMinisRouter.json(200, `{"ok":true,"seq":${row.seq}}`);
  }

  private stop(id: string): RouterResult {
    const row = this.find(id);
    if (!row) {
      return HarmonyMinisRouter.json(404, errorBody('No such session'));
    }
    this.streams.set(id, false);
    LocalAgentEngine.stop(id);
    row.status = 'cancelled';
    this.emit(row, '{"event":"run.cancelled"}');
    return HarmonyMinisRouter.json(200, `{"ok":true,"status":"cancelled"}`);
  }

  private events(id: string, after: number): RouterResult {
    const row = this.find(id);
    if (!row) {
      return HarmonyMinisRouter.json(404, errorBody('No such session'));
    }
    // 要的区段已经被环形缓冲丢掉了。静默地"从还剩下的最老一条开始发"会让控制端
    // 以为中间本来就没有事件,拼出来的正文是残缺的且它毫无感知 —— 显式回 410 +
    // 水位,让它按新的 after 重新订阅。与 Android(MinisHarnessRouter 的 410)一致。
    if (after < row.evictedThrough) {
      const oldest = row.evictedThrough;
      const message = `events up to seq=${oldest} were evicted; re-subscribe with after=${oldest}`;
      return HarmonyMinisRouter.json(410,
        `{"type":"resume","status":"gap","after":${after},"min_after":${oldest},"error":{"message":${JSON.stringify(message)}},"evicted_through":${oldest}}`);
    }
    const out = new RouterResult();
    out.status = 200;
    out.body = '{"streaming":true}';
    out.stream = true;
    out.sessionId = id;
    out.after = after;
    return out;
  }

  private startTurn(row: BodySession, text: string, thinking: string): void {
    const ctx = this.context;
    if (!ctx) {
      this.emit(row, HarmonyMinisRouter.runFailed('鸿蒙身体还没挂上上下文'));
      return;
    }
    const mine = LocalAgentEngine.bump(row.id);
    this.streams.set(row.id, true);
    row.status = 'running';
    this.emit(row, `{"event":"user.message","text":${JSON.stringify(text)}}`);
    sessionStore.ensureLoaded(ctx).then(() => {
      return LocalTools.hydrate(ctx);
    }).then(() => {
      if (LocalAgentEngine.current(row.id) !== mine) {
        return Promise.resolve();
      }
      if (!row.localId) {
        return sessionStore.create(ctx).then((session) => {
          row.localId = session.id;
          return sessionStore.append(ctx, session.id, 'user', text);
        });
      }
      return sessionStore.append(ctx, row.localId, 'user', text);
    }).then(() => {
      if (LocalAgentEngine.current(row.id) !== mine) {
        return;
      }
      LocalAgentEngine.run(ctx, row.id, mine, text, thinking, (delta: string) => {
        this.emit(row, `{"event":"message.delta","delta":${JSON.stringify(delta)}}`);
      }, (output: string) => {
        row.status = 'idle';
        this.emit(row, `{"event":"run.completed","output":${JSON.stringify(output)},"usage":{}}`);
        if (row.localId) {
          sessionStore.append(ctx, row.localId, 'assistant', output).catch(() => {
            // keep relay alive
          });
        }
      }, (message: string) => {
        row.status = 'idle';
        this.emit(row, HarmonyMinisRouter.runFailed(message));
      });
    }).catch((err: Error) => {
      if (LocalAgentEngine.current(row.id) !== mine) {
        return;
      }
      row.status = 'idle';
      this.emit(row, HarmonyMinisRouter.runFailed(`${err}`));
    });
  }

  /**
   * `run.failed` 同时带 `error` 和 `message`。
   *
   * 协议原文(Mac `harness-dialects.ts` / `harness-session.service.ts`)发的是
   * **`error`**;Android 发的是 `message`。iOS 两个都收(`error` 优先),
   * 本端 ChatPane 也两个都收 —— 所以两个都带才是四端都不会漏的写法。
   * 字段该统一成哪个,要在协议层拍板,这里先做兼容。
   */
  private static runFailed(message: string): string {
    const text = JSON.stringify(message);
    return `{"event":"run.failed","error":${text},"message":${text}}`;
  }

  private emit(row: BodySession, raw: string): void {
    row.seq += 1;
    let event = raw;
    let name = '';
    try {
      const obj = JSON.parse(raw) as Record<string, Object>;
      name = `${obj['event'] ?? ''}`;
      obj['seq'] = row.seq;
      obj['session_id'] = row.id;
      // 秒,不是毫秒。Mac 是 `Date.now() / 1000`(harness-session.service.ts),
      // Python 是 `time.time()`,Android 是 `System.currentTimeMillis() / 1000.0`。
      obj['timestamp'] = Date.now() / 1000;
      event = JSON.stringify(obj);
    } catch (_err) {
      event = raw;
    }
    row.events.push(event);
    row.retainedChars += event.length + EVENT_OVERHEAD_CHARS;
    row.lastTouched = Date.now();
    // 环形裁剪。留 `length > 1` 是为了单条事件自己就超预算时(比如一条超大的
    // run.completed)不要把最新的这条也一起丢掉。
    while (row.events.length > 1 &&
      (row.events.length > MAX_RETAINED_EVENTS || row.retainedChars > MAX_RETAINED_CHARS)) {
      const dropped = row.events.shift() ?? '';
      row.retainedChars -= dropped.length + EVENT_OVERHEAD_CHARS;
      row.evictedThrough += 1;
    }
    const sink = this.onLive;
    if (sink) {
      for (let i = 0; i < this.lives.length; i++) {
        if (this.lives[i].sessionId === row.id) {
          sink(this.lives[i].streamId, event);
        }
      }
    }
    const push = this.onPush;
    if (push && PUSH_EVENTS.indexOf(name) >= 0) {
      push(event);
    }
  }

  private find(id: string): BodySession | null {
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].id === id) {
        return this.sessions[i];
      }
    }
    return null;
  }

  private summaries(): string {
    const rows: string[] = [];
    for (let i = 0; i < this.sessions.length; i++) {
      const row = this.sessions[i];
      rows.push(`{"session_id":${JSON.stringify(row.id)},"harness":"minis","name":"LeoPhoneAgent","cwd":"~","status":${JSON.stringify(row.status)},"seq":${row.seq},"waiting_for_approval":false,"pending_approvals":[]}`);
    }
    return rows.join(',');
  }

  private static json(status: number, body: string): RouterResult {
    const out = new RouterResult();
    out.status = status;
    out.body = body;
    return out;
  }
}

export const harmonyRouter: HarmonyMinisRouter = new HarmonyMinisRouter();
