/**
 * GitContextService — 每个 workdir 的"当前 git 分支"实时感知服务(main 单例)。
 *
 * 职责:
 *   - get(workdir):按需读取当前 HEAD(fs 直读,零子进程),带短缓存
 *   - watch(workdir)/unwatch(workdir):refcount 管理 watcher 订阅,
 *     监听 gitdir 下 HEAD 文件变化(用户/agent 在会话中途 git checkout 时实时跟进),
 *     变化后 re-read 并通过 onChanged 回调向 renderer 广播
 *
 * watcher 策略:
 *   - 订阅经 watcher-host utility process(@parcel/watcher 的 native 调用不再
 *     发生在 main —— 背景见 ../watcher-host/protocol.ts 头注)。win32 的
 *     backend:'windows' 选择也统一收在 host 侧。
 *   - subscribe 是递归的;普通 checkout 的 gitdir 是整个 .git,objects/refs/logs
 *     在 fetch/commit 期间事件量很大 → 用 ignore 列表预剪,callback 内再按 headPath 精滤。
 *   - linked worktree 的 gitdir 是 `.git/worktrees/<name>/`,本身就很小。
 *   - HEAD 变化是低频事件(checkout),re-read 带 80ms debounce 合并 git 的临时写。
 *
 * 生命周期:renderer 对活跃会话调 watch,离开时 unwatch。refcount 归零后
 * 进入 UNWATCH_GRACE_MS 宽限期再真正取消订阅 —— 快速切 session 时 per-session
 * 徽标组件"先卸载旧、再挂载新",同一 gitdir 会在毫秒级被 unwatch→watch,
 * 宽限期让这种抖动完全不触碰 native 订阅。
 * 服务自身无 Electron 依赖(broadcast 与订阅函数由构造参数注入),可直接单测。
 */

import path from 'node:path';

import { createLogger } from '../logger.js';
import type { WatchedFsEvent } from '../watcher-host/protocol.js';
import type { WatcherHostSubscription } from '../watcher-host/WatcherHostClient.js';
import {
  readGitHead,
  resolveHeadLocation,
  type GitHeadInfo,
} from './headReader.js';

const log = createLogger('git-context');

/** 订阅函数抽象:默认走 watcher-host 单例,测试注入假实现。 */
export type GitWatchSubscribeFn = (
  dir: string,
  ignore: string[],
  onEvents: (events: WatchedFsEvent[]) => void,
  onError: (message: string) => void,
) => Promise<WatcherHostSubscription>;

/**
 * 默认订阅实现。动态 import 保证本模块在单测环境可加载(watcher-host/index
 * 顶层 import electron;运行时 main 进程首次 watch 时才真正加载)。
 */
const defaultSubscribeFn: GitWatchSubscribeFn = async (dir, ignore, onEvents, onError) => {
  const { watcherHostClient } = await import('../watcher-host/index.js');
  return watcherHostClient.subscribe(dir, ignore, onEvents, onError);
};

/** 广播给 renderer 的分支上下文(null = 非 git 目录)。 */
export interface GitContextSnapshot {
  workdir: string;
  head: GitHeadInfo | null;
}

interface WatchEntry {
  refCount: number;
  subscription: WatcherHostSubscription | null;
  /** debounce 句柄:HEAD 变化后合并 80ms 内的连续事件再 re-read。 */
  debounce: ReturnType<typeof setTimeout> | null;
  /** 订阅是异步建立的;期间再来 watch/unwatch 用这个 promise 串行化。 */
  starting: Promise<void> | null;
  /** refcount 归零后的宽限期定时器;期间 watch() 可复活。 */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const HEAD_REREAD_DEBOUNCE_MS = 80;

/**
 * unwatch 宽限期。与 file-browser watcher 的 STOP_GRACE_MS 同理:切 session
 * 的 unwatch→watch 抖动在毫秒级,1.5s 内复活即零 native 操作。
 */
const UNWATCH_GRACE_MS = 1500;

/** gitdir 下不需要看的大目录(HEAD 不在里面,事件量却最大)。 */
const GITDIR_IGNORE_SUBDIRS = ['objects', 'refs', 'logs', 'lfs', 'modules', 'worktrees', 'hooks', 'info'];

export class GitContextService {
  private readonly watches = new Map<string, WatchEntry>();
  private readonly lastSnapshot = new Map<string, GitHeadInfo | null>();
  private readonly onChanged: (snapshot: GitContextSnapshot) => void;
  private readonly subscribeFn: GitWatchSubscribeFn;

  constructor(opts: {
    onChanged: (snapshot: GitContextSnapshot) => void;
    subscribeFn?: GitWatchSubscribeFn;
  }) {
    this.onChanged = opts.onChanged;
    this.subscribeFn = opts.subscribeFn ?? defaultSubscribeFn;
  }

  /** 按需读取 workdir 当前分支。永不抛错;非 git 目录返回 head=null。 */
  async get(workdir: string): Promise<GitContextSnapshot> {
    const key = path.resolve(workdir);
    const head = await readGitHead(key);
    this.lastSnapshot.set(key, head);
    return { workdir: key, head };
  }

  /**
   * 开始监听 workdir 的 HEAD 变化(refcount +1)。
   * 非 git 目录是 no-op(不订阅,refcount 仍记账,unwatch 对称)。
   * 命中宽限期中的 entry 时直接复活,不触碰 native。
   */
  async watch(workdir: string): Promise<void> {
    const key = path.resolve(workdir);
    const existing = this.watches.get(key);
    if (existing) {
      existing.refCount++;
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        log.debug('watch revived within grace', { workdir: key });
      }
      return;
    }
    const entry: WatchEntry = {
      refCount: 1,
      subscription: null,
      debounce: null,
      starting: null,
      graceTimer: null,
    };
    this.watches.set(key, entry);
    entry.starting = this.startSubscription(key, entry).finally(() => {
      entry.starting = null;
    });
    await entry.starting;
  }

  /**
   * 停止监听(refcount -1)。归零后不立即取消订阅,先进宽限期;宽限内
   * watch() 复活则零成本,过期才真正 unsubscribe。
   */
  async unwatch(workdir: string): Promise<void> {
    const key = path.resolve(workdir);
    const entry = this.watches.get(key);
    if (!entry) return;
    if (entry.refCount <= 0) return; // 已在宽限期(refCount 已归零),忽略多余 unwatch
    entry.refCount--;
    if (entry.refCount > 0) return;
    if (entry.graceTimer) return; // 防御:定时器已在(不该发生,但幂等)
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      void this.teardownIfIdle(key, entry);
    }, UNWATCH_GRACE_MS);
    entry.graceTimer.unref?.();
  }

  /** 应用退出时清理全部订阅(无视宽限期)。 */
  async dispose(): Promise<void> {
    const keys = [...this.watches.keys()];
    await Promise.all(
      keys.map(async (key) => {
        const entry = this.watches.get(key);
        if (!entry) return;
        this.watches.delete(key);
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.graceTimer) clearTimeout(entry.graceTimer);
        if (entry.starting) await entry.starting.catch(() => undefined);
        await entry.subscription?.unsubscribe().catch(() => undefined);
      }),
    );
  }

  /** 宽限期到点:确认没被复活后真正拆订阅。 */
  private async teardownIfIdle(key: string, entry: WatchEntry): Promise<void> {
    if (this.watches.get(key) !== entry) return; // 已被替换/清理
    if (entry.refCount > 0) return; // 宽限期内被复活
    this.watches.delete(key);
    if (entry.debounce) clearTimeout(entry.debounce);
    // 订阅可能还在建立中——等它完成再取消,避免泄漏。
    if (entry.starting) await entry.starting.catch(() => undefined);
    if (entry.subscription) {
      await entry.subscription.unsubscribe().catch((err) => {
        log.warn('unsubscribe failed', { workdir: key, err: String(err) });
      });
    }
  }

  private async startSubscription(key: string, entry: WatchEntry): Promise<void> {
    const loc = await resolveHeadLocation(key);
    if (!loc) return; // 非 git 目录:不订阅。get() 已返回 head=null,renderer 不显示徽标。
    try {
      const ignore = GITDIR_IGNORE_SUBDIRS.map((d) => path.join(loc.gitDir, d));
      const subscription = await this.subscribeFn(
        loc.gitDir,
        ignore,
        (events) => {
          // 只关心 HEAD 本体的变化(git checkout 通过 rename 原子替换 HEAD)。
          const hit = events.some((e) => path.resolve(e.path) === loc.headPath);
          if (hit) this.scheduleReread(key);
        },
        (message) => {
          log.warn('watcher error', { workdir: key, err: message });
        },
      );
      // watch 期间可能已被清理(dispose / 宽限过期拆除)→ 立即取消。
      if (this.watches.get(key) !== entry) {
        await subscription.unsubscribe().catch(() => undefined);
        return;
      }
      entry.subscription = subscription;
      // 闭合订阅生效前的盲区:renderer 先 get() 后 watch(),两次 IPC + subscribe
      // 期间发生的 checkout 不会产生事件。订阅就绪后重读一次 HEAD,与缓存快照
      // 不一致才广播(Codex review P2)。
      this.scheduleReread(key);
    } catch (err) {
      log.warn('subscribe failed (branch badge falls back to on-demand reads)', {
        workdir: key,
        err: String(err),
      });
    }
  }

  private scheduleReread(key: string): void {
    const entry = this.watches.get(key);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      void this.rereadAndBroadcast(key);
    }, HEAD_REREAD_DEBOUNCE_MS);
  }

  private async rereadAndBroadcast(key: string): Promise<void> {
    const head = await readGitHead(key);
    const prev = this.lastSnapshot.get(key);
    // 浅比较去重:HEAD 临时写(如 rebase 中间态)可能触发多次事件但分支没变。
    if (prev !== undefined && headEquals(prev, head)) return;
    this.lastSnapshot.set(key, head);
    this.onChanged({ workdir: key, head });
  }
}

function headEquals(a: GitHeadInfo | null, b: GitHeadInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.branch === b.branch && a.shortSha === b.shortSha;
}
