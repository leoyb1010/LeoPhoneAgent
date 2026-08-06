/**
 * WatcherHostClient — main 侧的 watcher utility process 代理(依赖注入版)。
 *
 * 职责:
 *   - 惰性 fork watcher host 子进程,维护 RPC(id 配对 + 超时)
 *   - 订阅簿记:subId → 回调,事件推送按 subId 路由
 *   - 崩溃恢复:子进程意外退出 → 指数退避重启 + 重放全部活跃订阅;连续
 *     崩溃超限则降级(后续 subscribe 返回 no-op,watch 能力静默失效,
 *     文件树/分支徽标退化到聚焦刷新 / 按需读取 —— 与两处调用方既有的
 *     "watch 失败不致命"语义一致)
 *
 * fork / 日志等 Electron 依赖全部经 deps 注入,本文件可直接 vitest;真实
 * 接线(utilityProcess.fork + logger + before-quit dispose)在 ./index.ts。
 */

import type {
  WatchedFsEvent,
  WatcherHostMessage,
  WatcherHostRequest,
} from './protocol';

/** utilityProcess.fork 返回子进程的最小面。 */
export interface WatcherHostChildLike {
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (msg: unknown) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  kill(): boolean;
}

export interface WatcherHostLoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WatcherHostClientDeps {
  fork: () => WatcherHostChildLike;
  log: WatcherHostLoggerLike;
}

export interface WatcherHostSubscription {
  unsubscribe(): Promise<void>;
}

export type WatcherHostEventsHandler = (events: WatchedFsEvent[]) => void;
export type WatcherHostErrorHandler = (message: string) => void;

interface ActiveSub {
  subId: number;
  dir: string;
  ignore: string[];
  onEvents: WatcherHostEventsHandler;
  onError?: WatcherHostErrorHandler;
}

interface PendingRpc {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 单次 RPC 超时。subscribe 本身 ~ms 级,15s 只兜子进程假死。 */
const RPC_TIMEOUT_MS = 15_000;
/** 连续崩溃超过该值即降级(不再重启)。 */
const MAX_CONSECUTIVE_CRASHES = 5;
/** 子进程存活满该时长则清零连续崩溃计数。 */
const STABLE_RESET_MS = 60_000;
/** 重启退避基数:500ms * 2^(n-1),封顶 10s。 */
const RESTART_BACKOFF_BASE_MS = 500;
const RESTART_BACKOFF_MAX_MS = 10_000;

export class WatcherHostClient {
  private readonly deps: WatcherHostClientDeps;
  private child: WatcherHostChildLike | null = null;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly subs = new Map<number, ActiveSub>();
  private nextRpcId = 1;
  private nextSubId = 1;
  private consecutiveCrashes = 0;
  private degraded = false;
  private disposed = false;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: WatcherHostClientDeps) {
    this.deps = deps;
  }

  /**
   * 订阅一个目录。降级 / 已释放时返回 no-op 句柄(调用方无需感知——watch
   * 本来就是"尽力而为"的增强)。
   */
  async subscribe(
    dir: string,
    ignore: string[],
    onEvents: WatcherHostEventsHandler,
    onError?: WatcherHostErrorHandler,
  ): Promise<WatcherHostSubscription> {
    if (this.degraded || this.disposed) {
      return { unsubscribe: async () => undefined };
    }
    const backoff = this.waitForRestartBackoff();
    if (backoff) await backoff;
    if (this.degraded || this.disposed) {
      return { unsubscribe: async () => undefined };
    }
    const subId = this.nextSubId++;
    await this.rpc({ id: 0, op: 'subscribe', subId, dir, ignore });
    this.subs.set(subId, { subId, dir, ignore, onEvents, onError });
    return { unsubscribe: () => this.unsubscribeById(subId) };
  }

  /** 释放:kill 子进程,不再重启。app before-quit 时调用。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.rejectAllPending(new Error('watcher host client disposed'));
    this.subs.clear();
    try {
      this.child?.kill();
    } catch {
      /* 子进程可能已死 */
    }
    this.child = null;
  }

  /** 仅诊断/测试:当前活跃订阅数。 */
  get activeSubscriptionCount(): number {
    return this.subs.size;
  }

  /** 仅诊断/测试:是否已降级。 */
  get isDegraded(): boolean {
    return this.degraded;
  }

  private async unsubscribeById(subId: number): Promise<void> {
    if (!this.subs.delete(subId)) return; // 幂等
    if (!this.child || this.disposed || this.degraded) return;
    try {
      await this.rpc({ id: 0, op: 'unsubscribe', subId });
    } catch (err) {
      // 子进程正在崩溃/重启窗口——订阅已从簿记移除,重启重放不会带上它,
      // host 侧的残留订阅随子进程消亡,无泄漏。
      this.deps.log.debug('unsubscribe rpc failed (ignored)', {
        subId,
        err: String(err),
      });
    }
  }

  private ensureChild(): WatcherHostChildLike {
    if (this.child) return this.child;
    const child = this.deps.fork();
    this.child = child;
    child.on('message', (msg) => this.handleMessage(msg as WatcherHostMessage));
    child.on('exit', (code) => this.handleExit(child, code));
    // utilityProcess 可能通过 'error' 事件终止(如 V8 fatal error);不注册
    // 会让 EventEmitter 把未处理 error 抛到 main,绕过重启路径带走宿主进程。
    (child as unknown as { on(e: 'error', cb: (err: Error) => void): void }).on(
      'error',
      (err) => {
        this.deps.log.error('watcher host error event', { err: String(err) });
        // error 后通常紧跟 exit;若子进程已死但未触发 exit,主动走相同退出路径
        if (this.child === child) this.handleExit(child, 1);
      },
    );
    // 存活满 STABLE_RESET_MS 认为这轮重启已收敛,清零崩溃计数
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.consecutiveCrashes = 0;
    }, STABLE_RESET_MS);
    this.stableTimer.unref?.();
    return child;
  }

  private rpc(req: WatcherHostRequest): Promise<void> {
    const child = this.ensureChild();
    const id = this.nextRpcId++;
    const msg: WatcherHostRequest = { ...req, id };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handleRpcTimeout(id, req, child);
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.postMessage(msg);
    });
  }

  private handleRpcTimeout(id: number, req: WatcherHostRequest, child: WatcherHostChildLike): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(`watcher host rpc timeout: ${req.op}`));

    if (this.child !== child || this.disposed) return;
    this.deps.log.warn('watcher host rpc timeout, killing wedged host', {
      op: req.op,
      id,
    });
    try {
      child.kill();
    } catch (err) {
      this.deps.log.warn('failed to kill watcher host after rpc timeout', { err: String(err) });
    }
    // 有些假死场景 kill 后不一定及时产生 exit 事件;主动复用同一退出路径,
    // 让 pending RPC 被拒绝、订阅重放/退避/降级逻辑统一生效。当前超时的
    // RPC 已在上方从 pending 移除并 reject,这里显式保留“曾有 pending”
    // 语义,避免首个 subscribe 超时时被误判为 no active subs 的正常退出。
    this.handleExit(child, 1, { hadPendingRpc: true });
  }

  private handleMessage(msg: WatcherHostMessage): void {
    if (msg.kind === 'response') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve();
      else entry.reject(new Error(msg.error));
      return;
    }
    switch (msg.event) {
      case 'fs-events':
        this.subs.get(msg.subId)?.onEvents(msg.events);
        break;
      case 'watch-error': {
        const sub = this.subs.get(msg.subId);
        this.deps.log.warn('watcher error from host', {
          subId: msg.subId,
          dir: sub?.dir,
          message: msg.message,
        });
        sub?.onError?.(msg.message);
        break;
      }
      case 'log':
        this.deps.log[msg.level](`[watcher-host] ${msg.message}`);
        break;
    }
  }

  private handleExit(
    child: WatcherHostChildLike,
    code: number,
    opts: { hadPendingRpc?: boolean } = {},
  ): void {
    if (this.child !== child) return; // 已被替换/释放的旧实例
    this.child = null;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    const hadPendingRpc = opts.hadPendingRpc === true || this.pending.size > 0;
    this.rejectAllPending(new Error(`watcher host exited (code=${code})`));
    if (this.disposed) return;

    if (this.subs.size === 0 && !hadPendingRpc) {
      // 没有活跃订阅、也没有建连中的 RPC:不算连续崩溃,下次 subscribe 时惰性 fork。
      this.deps.log.info(`watcher host exited (code=${code}), no active subs, lazy refork`);
      return;
    }

    this.consecutiveCrashes++;
    if (this.consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
      this.degraded = true;
      this.deps.log.error(
        `watcher host crashed ${this.consecutiveCrashes} times consecutively — degrading, file watching disabled until app restart`,
      );
      for (const sub of this.subs.values()) {
        sub.onError?.('watcher host degraded');
      }
      this.subs.clear();
      return;
    }

    const delay = this.nextRestartDelayMs();
    if (this.subs.size === 0) {
      // 没有需要恢复的订阅:不主动重启,但保留退避窗口。这样 host 在首个
      // subscribe RPC 建立阶段崩溃(尚未写入 subs)时,下次 subscribe 也会等
      // 同一套退避并累计到降级阈值,避免 tight fork/crash loop。
      this.armRestartBackoffOnly(delay);
      this.deps.log.warn(
        `watcher host exited (code=${code}) while RPC pending, lazy refork after ${delay}ms (attempt ${this.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES})`,
      );
      return;
    }

    this.deps.log.warn(
      `watcher host exited unexpectedly (code=${code}), restarting in ${delay}ms (attempt ${this.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}, subs=${this.subs.size})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.resubscribeAll();
    }, delay);
    this.restartTimer.unref?.();
  }

  private nextRestartDelayMs(): number {
    return Math.min(
      RESTART_BACKOFF_BASE_MS * 2 ** (this.consecutiveCrashes - 1),
      RESTART_BACKOFF_MAX_MS,
    );
  }

  private armRestartBackoffOnly(delay: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
    }, delay);
    this.restartTimer.unref?.();
  }

  private waitForRestartBackoff(): Promise<void> | null {
    if (!this.restartTimer) return null;
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!this.restartTimer) resolve();
        else setTimeout(check, 10).unref?.();
      };
      check();
    });
  }

  private async resubscribeAll(): Promise<void> {
    if (this.disposed || this.degraded) return;
    for (const sub of [...this.subs.values()]) {
      // 重启窗口内可能已被 unsubscribe —— 簿记为准
      if (!this.subs.has(sub.subId)) continue;
      try {
        await this.rpc({ id: 0, op: 'subscribe', subId: sub.subId, dir: sub.dir, ignore: sub.ignore });
      } catch (err) {
        const message = `watcher host resubscribe failed: ${String(err)}`;
        this.deps.log.warn('resubscribe failed after watcher host restart', {
          dir: sub.dir,
          err: String(err),
        });
        sub.onError?.(message);
        // 如果失败来自 host exit/timeout,handleExit/handleRpcTimeout 已经清空
        // child 并布置下一轮退避。当前 replay 必须停止,否则下一项会立即
        // ensureChild() fork 新 host,绕过退避并和已布置的 timer 形成重叠重放。
        if (!this.child || this.restartTimer) break;
        // host 仍存活时(例如单个 subscribe 返回 ok:false),保留 sub 并继续
        // 尝试其它订阅;调用方已收到 onError fallback 通知。
      }
    }
    this.deps.log.info(`watcher host restarted, ${this.subs.size} subscription(s) restored`);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
