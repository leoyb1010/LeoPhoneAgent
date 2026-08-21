import { webSocket } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { harmonyRouter } from '../local/HarmonyMinisRouter';
import { bodyStore } from '../store/BodyStore';
import { gatewayStore } from '../store/GatewayStore';
import { providerStore } from '../store/ProviderStore';
import {
  agentWsUrl,
  eventJson,
  parseAgentFrame,
  registerJson,
  respJson,
  streamCloseJson,
  streamDataJson
} from './OutboundCodec';

/** 断线期间攒下的外推事件上限。Mac(relay_client.py / relay-client.service.ts)与 Android 都是 200。 */
const OUTBOX_LIMIT: number = 200;
/** 重连退避。另外三端都是 1s 起、翻倍、封顶 30s;固定间隔会在钥匙错时变成永久风暴。 */
const BACKOFF_MIN_MS: number = 1000;
const BACKOFF_MAX_MS: number = 30000;

export class OutboundClient {
  private sock: webSocket.WebSocket | null = null;
  private timer: number = -1;
  private context: common.UIAbilityContext | null = null;
  private backoff: number = BACKOFF_MIN_MS;
  private outbox: string[] = [];
  // 每次 connect() 递增。旧 socket 的 close/error 回调只有代号对得上才算数，
  // 否则它会在新 socket 已经建好之后再触发一次重连，把刚连上的连接又拆掉（见 dropSocket 注释）。
  private gen: number = 0;

  start(context: common.UIAbilityContext): void {
    this.context = context;
    harmonyRouter.attach(context);
    harmonyRouter.onLive = (streamId: string, data: string) => {
      this.send(streamDataJson(streamId, data));
    };
    harmonyRouter.onPush = (event: string) => {
      this.pushEvent(eventJson(bodyStore.name, event));
    };
    this.backoff = BACKOFF_MIN_MS;
    this.connect();
  }

  /**
   * 关键事件外推给中继(approval.request / run.completed / run.failed / run.cancelled)。
   *
   * 手机拉 SSE 只在它连着时才收得到。切后台或被杀之后,这条 `event` 帧是唯一的
   * 触达路径 —— 中继据此留最近事件(`GET /relay/api/events`)并发 APNs。
   * 之前鸿蒙身体一条都不推,任务跑完在 iPhone 上完全没有痕迹;Mac
   * (relay_client.push_event)和 Android(RelayOutboundClient.pushEvent)都推。
   *
   * 推不出去就排队,重连注册成功后补发 —— 丢事件就等于破了这条承诺。
   */
  private pushEvent(frame: string): void {
    if (this.sock && bodyStore.online) {
      this.sendEvent(frame);
      return;
    }
    this.queueEvent(frame);
  }

  /**
   * 满了丢最老的。
   *
   * why 不学中继那套"挤掉一帧改塞 stream_close 逼客户端重连补齐"(relay.py 的
   * 慢消费者分支):那是 live 流,一旦有洞就只能靠重连补;这条队列不是。手机真正
   * 的对账路径是 `GET /harness/sessions/{id}/events?after=N`(replay,权威且完整),
   * 这些 event 帧只喂中继那个"最近事件"环 —— 而它自己也只留 200 条
   * (relay.py 的 MAX_EVENTS),补发更老的本来就会被它丢掉。所以丢最老的没有
   * 制造新的信息缺口,不需要额外通知对端。
   */
  private queueEvent(frame: string): void {
    this.outbox.push(frame);
    while (this.outbox.length > OUTBOX_LIMIT) {
      this.outbox.shift();
    }
  }

  /**
   * 外推帧专用的发送:发失败就放回队列,等下次注册成功再补。
   *
   * why 不直接用 send():send() 是 fire-and-forget,拒绝了只记一条 lastError。
   * 对 stream_data 那种"过期即无用"的帧没问题,但 outbox 的全部意义就是不丢这
   * 四条关键事件,在出口再丢一次等于白排队。Mac(relay-client.service.ts 的 flush)
   * 同样会把发失败的帧放回去。
   */
  private sendEvent(frame: string): void {
    const sock = this.sock;
    if (!sock) {
      this.queueEvent(frame);
      return;
    }
    sock.send(frame).catch((err: Error) => {
      bodyStore.lastError = `${err}`;
      this.queueEvent(frame);
    });
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) {
      return;
    }
    const pending = this.outbox;
    this.outbox = [];
    for (let i = 0; i < pending.length; i++) {
      this.sendEvent(pending[i]);
    }
  }

  stop(): void {
    this.dropSocket();
    bodyStore.online = false;
    AppStorage.setOrCreate('bodyTick', Date.now());
  }

  private dropSocket(): void {
    this.clearTimer();
    // streamId 是中继给这条连接分配的,连接没了就全作废。不清的话重连后
    // 还会往死 id 上推 stream_data(中继按 id 查不到队列直接丢),订阅表只增不减。
    // Android 在 connectOnce 的 finally 里 cancelStreams(),Python 客户端同理。
    harmonyRouter.clearStreams();
    const sock = this.sock;
    if (sock) {
      // 先摘掉回调再关。原来直接 close()，旧 socket 的 'close' 事件仍然会异步打回来，
      // 走 schedule() 排一次 4 秒后的重连；那时新 socket 往往已经连上并注册好了，
      // 于是每 4 秒就被自己拆一次 —— 断线一次之后「当身体」再也稳不下来。
      this.gen += 1;
      try {
        sock.off('open');
        sock.off('message');
        sock.off('close');
        sock.off('error');
      } catch (_err) {
        // 回调本来就没挂上时忽略
      }
      sock.close().catch(() => {
        // 已经断了就不用再管
      });
      this.sock = null;
    }
  }

  private connect(): void {
    this.dropSocket();
    if (!bodyStore.on) {
      return;
    }
    const reason = bodyStore.canRegister();
    if (reason.length > 0) {
      bodyStore.lastError = reason;
      return;
    }
    const url = agentWsUrl(gatewayStore.apiRoot);
    const sock = webSocket.createWebSocket();
    this.gen += 1;
    const mine = this.gen;
    this.sock = sock;
    sock.on('open', () => {
      sock.send(registerJson(bodyStore.name, gatewayStore.key)).catch((err: Error) => {
        bodyStore.lastError = `${err}`;
      });
    });
    sock.on('message', (_err: Error, value: string | ArrayBuffer) => {
      if (mine !== this.gen) {
        return;
      }
      const text = typeof value === 'string' ? value : '';
      if (!text) {
        return;
      }
      this.onMessage(text);
    });
    sock.on('close', () => {
      if (!this.retire(mine)) {
        return;
      }
      bodyStore.online = false;
      AppStorage.setOrCreate('bodyTick', Date.now());
      this.schedule();
    });
    sock.on('error', (err: Error) => {
      if (!this.retire(mine)) {
        return;
      }
      bodyStore.lastError = `${err}`;
      bodyStore.online = false;
      AppStorage.setOrCreate('bodyTick', Date.now());
      this.schedule();
    });
    sock.connect(url).catch((err: Error) => {
      if (!this.retire(mine)) {
        return;
      }
      bodyStore.lastError = `${err}`;
      this.schedule();
    });
  }

  /**
   * 一次断线会连着触发好几个回调:connect() 的 reject、'error'、'close' 往往
   * 一起来。它们各调一次 schedule(),而 schedule() 每次都把 backoff 翻倍 ——
   * 一次失败翻两三倍,第二次就跳到 8s、第三次直接封顶 30s,和"1→2→4→8"的
   * 意图对不上(clearTimer 只保证了不会有多个定时器,拦不住重复翻倍)。
   *
   * 这里复用已有的分代号:第一个到达的回调把代号推进一格,后面的自然被
   * `mine !== this.gen` 挡掉。gen 只要单调递增就行,多加几次没有副作用。
   */
  private retire(mine: number): boolean {
    if (mine !== this.gen) {
      return false;
    }
    this.gen += 1;
    return true;
  }

  private onMessage(text: string): void {
    const frame = parseAgentFrame(text);
    if (!frame) {
      return;
    }
    if (frame.type === 'registered') {
      bodyStore.online = true;
      bodyStore.lastError = '';
      this.backoff = BACKOFF_MIN_MS;
      AppStorage.setOrCreate('bodyTick', Date.now());
      this.flushOutbox();
      return;
    }
    if (frame.type === 'http') {
      const result = harmonyRouter.handle(frame.method, frame.path, frame.body);
      this.send(respJson(frame.id, result.status, result.body));
      return;
    }
    if (frame.type === 'stream_open') {
      this.openStream(frame.id, frame.path);
      return;
    }
    if (frame.type === 'stream_cancel') {
      harmonyRouter.unsubscribe(frame.id);
      this.send(streamCloseJson(frame.id));
    }
  }

  private openStream(id: string, path: string): void {
    const result = harmonyRouter.handle('GET', path, '');
    if (!result.stream) {
      // 中继此刻挂在这条 stream 的队列上等 stream_data / stream_close。
      // `resp` 帧走的是另一张表(按 request_id 找 future),查不到就被直接丢掉 ——
      // 不补一条 stream_close,手机那侧的 SSE 会一直空转到自己超时。
      // 会话是纯内存态的,App 一重启 iPhone 手里的旧 session 全部落到这条
      // 404 分支,所以这不是边角情况。Mac(relay_client.py 的 finally、
      // relay-client.service.ts 的 finally)和 Android
      // (RelayOutboundClient.handleStream 的 finally)都保证发这一条。
      this.send(respJson(id, result.status, result.body));
      this.send(streamCloseJson(id));
      return;
    }
    const rows = harmonyRouter.replay(result.sessionId, result.after);
    for (let i = 0; i < rows.length; i++) {
      this.send(streamDataJson(id, rows[i]));
    }
    harmonyRouter.subscribe(id, result.sessionId);
  }

  private send(text: string): void {
    if (this.sock) {
      // send 返回 Promise，之前没接；连接刚断时会变成未处理拒绝
      this.sock.send(text).catch((err: Error) => {
        bodyStore.lastError = `${err}`;
      });
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!bodyStore.on) {
      return;
    }
    // 指数退避,注册成功后归位。固定 4 秒的老写法在钥匙不对(中继用 4001 关连接)
    // 时会永远每 4 秒撞一次墙 —— Mac 的 relay_client.py 专门记过这个坑。
    const delay = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.timer = setTimeout(() => {
      this.timer = -1;
      this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer >= 0) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }
}

export const outboundClient: OutboundClient = new OutboundClient();

export function startBody(context: common.UIAbilityContext): void {
  Promise.all([
    gatewayStore.ensureLoaded(context),
    providerStore.ensureLoaded(context),
    bodyStore.load(context)
  ]).then(() => {
    if (bodyStore.on) {
      outboundClient.start(context);
    }
  });
}
