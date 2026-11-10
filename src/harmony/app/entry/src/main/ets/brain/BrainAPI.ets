import { http } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { userAuth } from '@kit.UserAuthenticationKit';
import { SecretStore } from '../store/SecretStore';

export type BrainJSON = Record<string, Object>;
export function text(o: BrainJSON, key: string): string { return `${o[key] ?? ''}`; }
export function object(o: BrainJSON, key: string): BrainJSON { return (o[key] as BrainJSON) ?? {}; }
export function items(o: BrainJSON, key: string = 'items'): BrainJSON[] { return (o[key] as BrainJSON[]) ?? []; }
export function part(id: string): string { return encodeURIComponent(id); }

export class BrainRequestLease {
  generation: string = '';
  epoch: number = 0;
}
class BrainHTTPError extends Error {
  code: number;
  sessionExpired: boolean;
  constructor(code: number, sessionExpired: boolean) {
    super(sessionExpired ? '资料库网页会话已过期' : `资料库返回 ${code}，请检查权限或稍后重试`);
    this.code = code; this.sessionExpired = sessionExpired;
  }
}

export class BrainConnection {
  base: string = '';
  token: string = '';
  accessId: string = '';
  accessSecret: string = '';
  generation: string = '';
}

/** Each request captures one credential generation. Redirects never carry device credentials. */
export class BrainAPI {
  private static config: BrainConnection = new BrainConnection();
  private static epoch: number = 0;
  private static binaryRunning: number = 0;
  private static pageToken: string = '';
  private static requests: Set<http.HttpRequest> = new Set();
  static unlockedUntil: number = 0;

  static async load(): Promise<BrainConnection> {
    const raw = await SecretStore.read('leo.harmony.brain.connection');
    const next = raw ? JSON.parse(raw) as BrainConnection : new BrainConnection();
    if (next.generation !== BrainAPI.config.generation) BrainAPI.invalidate();
    BrainAPI.config = next;
    return next;
  }

  static async connect(base: string, token: string, accessId: string, accessSecret: string): Promise<void> {
    const normalized = base.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(normalized) || token.trim().length < 16) {
      throw new Error('请输入 HTTPS 资料库地址和独立设备钥匙');
    }
    const next = new BrainConnection();
    next.base = normalized;
    next.token = token.trim();
    next.accessId = accessId.trim();
    next.accessSecret = accessSecret.trim();
    next.generation = util.generateRandomUUID(false);
    await SecretStore.write('leo.harmony.brain.connection', JSON.stringify(next));
    BrainAPI.invalidate();
    BrainAPI.config = next;
  }

  static invalidate(): void {
    BrainAPI.epoch += 1;
    BrainAPI.pageToken = '';
    BrainAPI.unlockedUntil = 0;
    // Lock / credential change destroys every in-flight request exactly once. The request's own
    // finally then sees it is no longer tracked and does not destroy it a second time.
    const active: http.HttpRequest[] = [];
    BrainAPI.requests.forEach((req: http.HttpRequest) => { active.push(req); });
    BrainAPI.requests.clear();
    active.forEach((req: http.HttpRequest) => { try { req.destroy(); } catch (_error) { } });
  }
  /** Destroys a request only if it is still tracked; returns false when invalidate() already did. */
  private static release(req: http.HttpRequest): boolean {
    if (!BrainAPI.requests.delete(req)) return false;
    try { req.destroy(); } catch (_error) { }
    return true;
  }
  static base(): string { return BrainAPI.config.base; }
  static async webSession(): Promise<BrainJSON> {
    const raw = await BrainAPI.request('/v1/app/web-session', http.RequestMethod.POST, '', {}, false);
    return JSON.parse(raw as string) as BrainJSON;
  }
  static lease(): BrainRequestLease {
    const value = new BrainRequestLease(); value.generation = BrainAPI.generation(); value.epoch = BrainAPI.epoch; return value;
  }
  static assertLease(value: BrainRequestLease): void {
    if (value.generation !== BrainAPI.generation() || value.epoch !== BrainAPI.epoch) throw new Error('连接或解锁状态已改变');
    BrainAPI.requireUnlocked();
  }
  static generation(): string { return BrainAPI.config.generation; }
  static active(generation: string): boolean { return generation === BrainAPI.config.generation; }
  static requireUnlocked(): void {
    if (Date.now() >= BrainAPI.unlockedUntil) throw new Error('请先解锁私密资料');
  }
  static async unlock(title: string): Promise<void> {
    const generation = BrainAPI.config.generation;
    const epoch = BrainAPI.epoch;
    await new Promise<void>((resolve, reject) => {
      const auth = userAuth.getUserAuthInstance({ challenge: new Uint8Array(32),
        authType: [userAuth.UserAuthType.FACE, userAuth.UserAuthType.FINGERPRINT, userAuth.UserAuthType.PIN],
        authTrustLevel: userAuth.AuthTrustLevel.ATL3 }, { title: title });
      auth.on('result', { onResult: (result: userAuth.UserAuthResult) => {
        if (result.result === 0 && epoch === BrainAPI.epoch && BrainAPI.active(generation)) resolve();
        else reject(new Error('设备认证未完成'));
      } });
      auth.start();
    });
    BrainAPI.unlockedUntil = Date.now() + 5 * 60 * 1000;
  }
  static async get(path: string, query: string = ''): Promise<BrainJSON> {
    return BrainAPI.json('/v1/app/api' + path + query);
  }
  static async manifest(): Promise<BrainJSON> { return BrainAPI.json('/v1/app/manifest'); }
  static async post(path: string, body: BrainJSON, lease: BrainRequestLease = BrainAPI.lease()): Promise<BrainJSON> {
    return BrainAPI.postBytes(path, JSON.stringify(body), 'application/json', {}, lease);
  }
  static async postBytes(path: string, body: string | ArrayBuffer, mime: string,
    extra: Record<string, string> = {}, lease: BrainRequestLease = BrainAPI.lease()): Promise<BrainJSON> {
    BrainAPI.assertLease(lease);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!BrainAPI.pageToken || attempt > 0) {
        const session = await BrainAPI.get('/session');
        BrainAPI.assertLease(lease);
        const token = text(session, 'token');
        if (!token) throw new Error('资料库未返回有效会话');
        BrainAPI.pageToken = token;
      }
      BrainAPI.assertLease(lease);
      const headers: Record<string, string> = { 'Content-Type': mime, 'X-Leo-Token': BrainAPI.pageToken };
      Object.keys(extra).forEach((key: string) => headers[key] = extra[key]);
      try {
        const raw = await BrainAPI.request('/v1/app/api' + path, http.RequestMethod.POST, body, headers, false, lease);
        BrainAPI.assertLease(lease);
        return JSON.parse(raw as string) as BrainJSON;
      } catch (error) {
        BrainAPI.assertLease(lease);
        if (attempt === 0 && error instanceof BrainHTTPError && error.code === 403 && error.sessionExpired) {
          BrainAPI.pageToken = ''; continue;
        }
        throw error as Error;
      }
    }
    throw new Error('资料库会话刷新后仍未能提交');
  }
  static async bytes(path: string): Promise<ArrayBuffer> {
    BrainAPI.requireUnlocked();
    const epoch = BrainAPI.epoch;
    while (BrainAPI.binaryRunning >= 4) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (epoch !== BrainAPI.epoch) throw new Error('连接已改变');
    }
    BrainAPI.requireUnlocked();
    BrainAPI.binaryRunning += 1;
    try { return await BrainAPI.request('/v1/app/api' + path, http.RequestMethod.GET, '', {}, true) as ArrayBuffer; }
    finally { BrainAPI.binaryRunning -= 1; }
  }
  /** Stream large media to an app-private file with bounded memory and no credential redirects. */
  static async download(path: string, destination: string): Promise<void> {
    BrainAPI.requireUnlocked();
    if (!/^\/media\/[A-Za-z0-9_%.-]+\/video$/.test(path)) throw new Error('视频路径无效');
    const cfg = BrainAPI.config;
    const epoch = BrainAPI.epoch;
    const req = http.createHttp();
    const file = fileIo.openSync(destination, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    const headers: Record<string, string> = { 'Authorization': 'Bearer ' + cfg.token };
    if (cfg.accessId && cfg.accessSecret) {
      headers['CF-Access-Client-Id'] = cfg.accessId;
      headers['CF-Access-Client-Secret'] = cfg.accessSecret;
    }
    let failure = '';
    let size = 0;
    BrainAPI.requests.add(req);
    req.on('dataReceive', (data: ArrayBuffer) => {
      try {
        BrainAPI.requireUnlocked();
        if (epoch !== BrainAPI.epoch) throw new Error('连接已改变');
        if (fileIo.writeSync(file.fd, data) !== data.byteLength) throw new Error('视频暂存不完整');
        size += data.byteLength;
      } catch (error) { failure = `${error}`; BrainAPI.release(req); }
    });
    let complete = false;
    try {
      const code = await req.requestInStream(cfg.base + '/v1/app/api' + path, {
        method: http.RequestMethod.GET, header: headers, maxRedirects: 0, usingCache: false,
        connectTimeout: 15000, readTimeout: 120000
      });
      if (failure) throw new Error(failure);
      if (epoch !== BrainAPI.epoch || Date.now() >= BrainAPI.unlockedUntil) throw new Error('资料已锁定');
      if (code !== 200 || size === 0) throw new Error(`视频返回 ${code}，请稍后重试`);
      fileIo.fsyncSync(file.fd);
      complete = true;
    } finally {
      try { req.off('dataReceive'); } catch (_error) { }
      BrainAPI.release(req); fileIo.closeSync(file);
      if (!complete && fileIo.accessSync(destination)) fileIo.unlinkSync(destination);
    }
  }
  static async chunks(id: string, offset: number): Promise<BrainJSON> {
    return BrainAPI.json('/v1/files/' + part(id) + '/chunks?offset=' + offset + '&limit=12');
  }
  /** General-tier Agent bridge uses v1 APIs and never grants the app/media routes to a model. */
  static async agentGet(path: string): Promise<BrainJSON> {
    if (!/^\/v1\/(search\?|files\/|answers\/)/.test(path)) throw new Error('工具资料路径无效');
    return JSON.parse(await BrainAPI.request(path, http.RequestMethod.GET, '', {}, false) as string) as BrainJSON;
  }
  static async agentAsk(body: BrainJSON): Promise<BrainJSON> {
    return JSON.parse(await BrainAPI.request('/v1/ask', http.RequestMethod.POST, JSON.stringify(body),
      { 'Content-Type': 'application/json' }, false) as string) as BrainJSON;
  }
  private static async json(path: string): Promise<BrainJSON> {
    return JSON.parse(await BrainAPI.request(path, http.RequestMethod.GET, '', {}, false) as string) as BrainJSON;
  }
  private static async request(path: string, method: http.RequestMethod, body: string | ArrayBuffer,
    extra: Record<string, string>, binary: boolean, lease?: BrainRequestLease): Promise<string | ArrayBuffer> {
    if (!/^\/v1\//.test(path) || /[\r\n#]/.test(path)) throw new Error('资料路径无效');
    if (lease) BrainAPI.assertLease(lease);
    const cfg = BrainAPI.config;
    if (!cfg.base || !cfg.token) throw new Error('请先连接第二大脑');
    const epoch = BrainAPI.epoch;
    const headers: Record<string, string> = { 'Authorization': 'Bearer ' + cfg.token, 'Accept': binary ? '*/*' : 'application/json' };
    if (cfg.accessId && cfg.accessSecret) {
      headers['CF-Access-Client-Id'] = cfg.accessId;
      headers['CF-Access-Client-Secret'] = cfg.accessSecret;
    }
    Object.keys(extra).forEach((key: string) => headers[key] = extra[key]);
    // @ohos.net.http: each HttpRequest is one request task and is not reusable, so no pooling.
    const req = http.createHttp();
    BrainAPI.requests.add(req);
    try {
      const response = await req.request(cfg.base + path, { method: method, header: headers,
        extraData: body, maxRedirects: 0, usingCache: false, maxLimit: 64 * 1024 * 1024, connectTimeout: 15000, readTimeout: 60000,
        expectDataType: binary ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING });
      if (epoch !== BrainAPI.epoch || cfg.generation !== BrainAPI.generation()) throw new Error('连接已改变，请重新打开');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        let message = '';
        if (typeof response.result === 'string') {
          try { message = text(JSON.parse(response.result) as BrainJSON, 'error'); } catch (_parseError) { }
        }
        const expired = response.responseCode === 403 && /会话.*(失效|过期|无效)|(?:invalid|expired).*session|session.*(?:invalid|expired)/i.test(message);
        throw new BrainHTTPError(response.responseCode, expired);
      }
      return response.result as string | ArrayBuffer;
    } finally { BrainAPI.release(req); }
  }
}
