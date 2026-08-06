/**
 * useClaudeSubscriptionUsage — 订阅 Claude 订阅(Anthropic OAuth)账号余量实时推送。
 *
 * 数据语义:5h 滚动窗口 / 总周限 / 分模型周窗口(Fable / Opus / Sonnet 各自独立)的
 * 已用百分比 + reset 时间,类型与合并语义见 shared/claudeSubscriptionUsage.ts。
 *
 * 数据通道:
 *   - main/usage/claudeSubscriptionUsageRefresh(oauth/usage 端点,cached-first + 节流)
 *   - main/maker-host/claude-rate-limit-headers-observer(proxy 旁路读订阅直连响应的
 *     unified headers,turn 内实时刷新)
 *   两者都汇入 usageBroadcaster.recordClaudeSubscriptionUsageSnapshot → 落库 + push。
 *   IPC 出口: electronAPI.maker.usage.{getClaudeSubscription, onClaudeSubscriptionChanged}
 *
 * 触发时机:
 *   - mount 时调一次 getClaudeSubscription(main 端 cached-first,无快照会触发后台刷新)
 *   - 后续端点刷新 / headers 更新时 main push,本 hook 收 push 直接覆盖
 *
 * 与 useClaudeAccountUsage(网关配额)是两回事:那份是 XD gateway key 在 LiteLLM 上的
 * spend;本份是用户 Anthropic 订阅的套餐窗口余量,只在订阅会话(providerId='anthropic')
 * 显示。账号级数据,全局共享一份 module-local cache,切会话不闪回占位态。
 */

import { useEffect, useState } from 'react';

import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';

export type { ClaudeSubscriptionUsageSnapshot };

let lastSnapshot: ClaudeSubscriptionUsageSnapshot | null = null;

function isSnapshot(v: unknown): v is ClaudeSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** push payload → 下一个缓存值(纯函数, 供单测): null 清空, 快照覆盖, 异常保留。 */
export function reduceClaudeSubscriptionPush(
  current: ClaudeSubscriptionUsageSnapshot | null,
  payload: unknown,
): ClaudeSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

// module 级常驻订阅 —— 与组件生命周期解耦:所有订阅 chip 卸载期间发生登出 / 换号
// 时, main 的 null / 新快照广播也要同步进 module 缓存, 否则下次 mount 的 useState
// initializer 会先 seed 旧账号数据闪一帧(warm-start read 纠正之前)。幂等安装,
// 随 renderer 进程存活, 不退订(与 preload fanOut 的常驻语义一致)。
let moduleSubscriptionInstalled = false;
function ensureModuleSubscription(): void {
  if (moduleSubscriptionInstalled) return;
  const api = readUsageApi();
  if (!api?.onClaudeSubscriptionChanged) return;
  moduleSubscriptionInstalled = true;
  api.onClaudeSubscriptionChanged((payload: unknown) => {
    lastSnapshot = reduceClaudeSubscriptionPush(lastSnapshot, payload);
  });
}

/**
 * 把 getClaudeSubscription 的返回归一成动作(纯函数, 供单测):
 *   - null → 'clear':main 侧已清快照(登出 / 换号指纹失配), renderer 必须同步清
 *     module cache 与 state —— 若清除广播发生在 hook 订阅之前, 不清这里会把上一个
 *     账号的余量一直顶在 chip 上。
 *   - snapshot → 'apply';其它形状(IPC 异常值)→ 'ignore', 保留现状。
 */
export function resolvePersistedClaudeSubscriptionRead(
  persisted: unknown,
):
  | { action: 'clear' }
  | { action: 'apply'; snapshot: ClaudeSubscriptionUsageSnapshot }
  | { action: 'ignore' } {
  if (persisted === null) return { action: 'clear' };
  if (isSnapshot(persisted)) return { action: 'apply', snapshot: persisted };
  return { action: 'ignore' };
}

function readUsageApi(): {
  getClaudeSubscription?: () => Promise<unknown | null>;
  onClaudeSubscriptionChanged?: (cb: (payload: unknown) => void) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getClaudeSubscription?: () => Promise<unknown | null>;
          onClaudeSubscriptionChanged?: (cb: (payload: unknown) => void) => () => void;
        };
      };
    };
  }).electronAPI?.maker?.usage;
}

/**
 * 主动催一次余量刷新(chip 悬念期用: 倒计时归零等新快照时)。走与 warm-start 同一
 * 个 cached-first IPC —— main 侧 read() 自带 180s 节流 + 退避, 重复调用安全;
 * 刷新结果经 push 通道回流, 这里不消费返回值。
 */
export function requestClaudeSubscriptionRefresh(): void {
  const api = readUsageApi();
  if (!api?.getClaudeSubscription) return;
  void api.getClaudeSubscription().catch(() => {
    /* Best-effort nudge; push 更新仍会刷新 chip。 */
  });
}

export function useClaudeSubscriptionUsage(
  enabled: boolean,
): ClaudeSubscriptionUsageSnapshot | null {
  // 幂等; 首个实例装上 module 常驻订阅, 保证卸载窗口内的广播不丢。
  ensureModuleSubscription();
  const [snapshot, setSnapshot] = useState<ClaudeSubscriptionUsageSnapshot | null>(() =>
    enabled ? lastSnapshot : null,
  );

  useEffect(() => {
    setSnapshot(enabled ? lastSnapshot : null);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const api = readUsageApi();
    if (!api?.getClaudeSubscription) return;

    let cancelled = false;
    void api
      .getClaudeSubscription()
      .then((persisted) => {
        if (cancelled) return;
        const resolved = resolvePersistedClaudeSubscriptionRead(persisted);
        if (resolved.action === 'clear') {
          lastSnapshot = null;
          setSnapshot(null);
          return;
        }
        if (resolved.action === 'apply') {
          lastSnapshot = resolved.snapshot;
          setSnapshot(resolved.snapshot);
        }
      })
      .catch(() => {
        /* Best-effort warm start; push 更新仍会刷新 chip。 */
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const api = readUsageApi();
    if (!api?.onClaudeSubscriptionChanged) return;

    let cancelled = false;
    const unsubscribe = api.onClaudeSubscriptionChanged((payload: unknown) => {
      if (cancelled) return;
      // main 侧已做双源 merge, push 的是合并后全量; null = 登出 / 换号清除。
      // 与 module 常驻订阅共用同一 reduce, 双写 lastSnapshot 幂等。
      const next = reduceClaudeSubscriptionPush(lastSnapshot, payload);
      lastSnapshot = next;
      setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return snapshot;
}
