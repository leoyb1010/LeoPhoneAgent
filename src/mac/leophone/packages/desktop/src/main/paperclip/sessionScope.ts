/** 普通 API 的超时；附件下载另用更长的超时，见 PAPERCLIP_DOWNLOAD_TIMEOUT_MS。 */
const REQUEST_TIMEOUT_MS = 60_000;
/** 附件最大 64 MB，慢速网络下 60 秒不足以读完；下载使用独立的 10 分钟上限。 */
export const PAPERCLIP_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** 读请求身份确认的短缓存；过期或任一失效事件后必须重新向服务器确认。 */
const IDENTITY_TTL_MS = 2_000;

/** 单一 origin 的 IO 生命周期；退出等待所有旧响应结束，再清理 Cookie。 */
export class PaperclipSessionScope {
  generation = 0;
  signingOut = false;
  private readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();
  // 身份确认缓存只属于本 origin 的隔离会话分区；version 在注销、登录窗口变化、
  // Cookie 变更和 401 时推进，旧确认结果与旧的进行中查询都不能跨过这些边界。
  private identityVersion = 0;
  private confirmed: { version: number; userId: string | null; at: number } | null = null;
  private probing: { version: number; result: Promise<string | null> } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    allowSignOut = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.signingOut && !allowSignOut) throw new Error("正在退出服务器，请稍候");
    const epoch = this.generation;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const record = { controller, done };
    this.active.add(record);
    try {
      const result = await work(
        AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      );
      if (epoch !== this.generation) throw new Error("服务器会话已更改，请重新连接");
      return result;
    } finally {
      this.active.delete(record);
      finish();
    }
  }

  /** 任何可能改变当前登录者的事件都调用它；之后的请求必须重新查询服务器身份。 */
  invalidateIdentity(): void {
    this.identityVersion += 1;
    this.confirmed = null;
    this.probing = null;
  }

  /**
   * 修复审计 P2（每个读请求先额外 GET get-session）：同一会话内的并发确认合并为一次查询，
   * 读请求可复用 2 秒内的确认结果。fresh（写请求与附件下载）不使用缓存，只与已在进行中的
   * 查询共享结果。查询期间发生失效时，本次结果仍是服务器的实时回答，但不写入缓存。
   */
  async currentUser(probe: () => Promise<string | null>, fresh: boolean): Promise<string | null> {
    const version = this.identityVersion;
    const cached = this.confirmed;
    if (
      !fresh &&
      cached?.version === version &&
      this.now() - cached.at >= 0 &&
      this.now() - cached.at < IDENTITY_TTL_MS
    )
      return cached.userId;
    let probing = this.probing?.version === version ? this.probing : null;
    if (!probing) {
      const current: { version: number; result: Promise<string | null> } = {
        version,
        result: probe(),
      };
      probing = current;
      this.probing = current;
      current.result.then(
        (userId) => {
          if (this.probing === current) this.probing = null;
          if (this.identityVersion === version)
            this.confirmed = { version, userId, at: this.now() };
        },
        () => {
          if (this.probing === current) this.probing = null;
        },
      );
    }
    return probing.result;
  }

  async beginSignOut(): Promise<void> {
    if (this.signingOut) throw new Error("正在退出服务器，请稍候");
    this.signingOut = true;
    this.generation += 1;
    this.invalidateIdentity();
    const pending = [...this.active];
    for (const item of pending) item.controller.abort();
    await Promise.all(pending.map((item) => item.done));
  }

  finishSignOut(): void {
    this.signingOut = false;
  }
}
