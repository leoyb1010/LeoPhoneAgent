/**
 * WatcherHostCore — watcher utility process 内的订阅簿记核心。
 *
 * 职责:把 main 发来的 subscribe/unsubscribe RPC 落到 parcel watcher 上,
 * 并把 parcel 回调事件按 subId 推回 main。依赖(parcel 加载器 / postMessage /
 * 平台)全部注入,不 import Electron,也不直接 require native —— 这样可以在
 * vitest 里用假 parcel 直接单测,真实接线在 watcherHostProcess.ts。
 *
 * 平台注记:win32 显式指定 backend:'windows',跳过 parcel 默认的 watchman
 * 探测(popen "watchman get-sockname" 在已签名 packaged 进程里会触发 Defender
 * 扫描 + 一闪而过的 cmd 窗,稳定阻塞 ~5s);macOS/Linux 让 parcel 自选原生
 * 后端(FSEvents / inotify),指定错后端会丢事件。
 */

import type {
  WatchedFsEvent,
  WatcherHostMessage,
  WatcherHostRequest,
} from './protocol';

/** parcel AsyncSubscription 的最小面。 */
export interface SubscriptionLike {
  unsubscribe(): Promise<void>;
}

/** @parcel/watcher 模块的最小面(仅 host 用到的部分)。 */
export interface ParcelLike {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: WatchedFsEvent[]) => void,
    opts: { ignore: string[]; backend?: string },
  ): Promise<SubscriptionLike>;
}

export interface WatcherHostCoreDeps {
  /** 惰性加载 parcel(首次 subscribe 才 require native,失败走 error 响应)。 */
  loadParcel: () => ParcelLike;
  /** 把消息发回 main(响应 + 事件推送共用)。 */
  post: (msg: WatcherHostMessage) => void;
  /** 注入平台便于单测 backend 分支;缺省取 process.platform。 */
  platform?: NodeJS.Platform;
}

export class WatcherHostCore {
  private readonly subs = new Map<number, SubscriptionLike>();
  private readonly deps: WatcherHostCoreDeps;

  constructor(deps: WatcherHostCoreDeps) {
    this.deps = deps;
  }

  /** 处理一条 main 发来的请求。永不 throw —— 失败以 ok:false 响应表达。 */
  async handleRequest(req: WatcherHostRequest): Promise<void> {
    try {
      if (req.op === 'subscribe') {
        await this.doSubscribe(req.subId, req.dir, req.ignore);
      } else {
        await this.doUnsubscribe(req.subId);
      }
      this.deps.post({ kind: 'response', id: req.id, ok: true });
    } catch (err) {
      this.deps.post({
        kind: 'response',
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 当前活跃订阅数(仅诊断/测试用)。 */
  get size(): number {
    return this.subs.size;
  }

  private async doSubscribe(subId: number, dir: string, ignore: string[]): Promise<void> {
    if (this.subs.has(subId)) return; // 幂等:重复 subscribe 同一 subId 视为已就绪
    const parcel = this.deps.loadParcel();
    const platform = this.deps.platform ?? process.platform;
    const opts =
      platform === 'win32' ? { ignore, backend: 'windows' as const } : { ignore };
    const subscription = await parcel.subscribe(
      dir,
      (err, events) => {
        if (err) {
          this.deps.post({
            kind: 'push',
            event: 'watch-error',
            subId,
            message: err.message ?? String(err),
          });
          return;
        }
        if (events.length === 0) return;
        this.deps.post({ kind: 'push', event: 'fs-events', subId, events });
      },
      opts,
    );
    // 请求由入口(watcherHostProcess)全局串行化,subscribe await 期间不会
    // 插入同 subId 的 unsubscribe,这里直接落表即可。
    this.subs.set(subId, subscription);
  }

  private async doUnsubscribe(subId: number): Promise<void> {
    const sub = this.subs.get(subId);
    if (!sub) return; // 幂等
    this.subs.delete(subId);
    await sub.unsubscribe();
  }
}
