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
        `{"object":"leoagent.capabilities","platform":"harmony","version":${JSON.stringify(PROTOCOL_VERSION)},"server":"minis","app_version":${JSON.stringify(ReleaseCatalog.currentVersion)},"features":{"harness_sessions":true,"resumable_events":true,"approval_events":false,"session_steering":true,"session_digest":false,"task_receipts":false,"artifacts":false},"harnesses":[{"key":"minis","name":"LeoPhoneAgent"}]}`);
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

  replay(sessionId: string, after: number): string[] {
    const row = this.find(sessionId);
    if (!row) {
      return [];
    }
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
