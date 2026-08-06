/**
 * usageBroadcaster 的 Claude 订阅快照段单测 —— 专注冷缓存 hydration 的并发语义:
 *   - 并发 record 等同一次 SQLite 读完成后按到达顺序 merge(旧持久化行不得覆盖新数据)
 *   - clear 抢先于 in-flight hydration 时, 读回的旧行不得复活
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(async () => undefined),
  getCurrentUserId: vi.fn(() => 'user-1'),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/dailySpend', () => ({
  incrementDailySpend: vi.fn(),
  getTodaySpend: vi.fn(async () => 0),
  localDayKey: () => '2026-07-02',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: vi.fn(),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} }),
}));
vi.mock('../localDb/index', () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('claude subscription snapshot hydration race', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset();
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  it('does not drop the very first snapshot after main start (owner init is not invalidation)', async () => {
    // record 在 ensure 之前捕获世代; 首笔快照到达时 owner 尚未初始化, ensure 里的
    // owner 首次初始化若 bump 世代, 这笔会被复查误丢 —— chip 要空到下一次刷新
    // (headers 单笔 + 端点 180s 节流)。首次初始化必须不算失效事件。
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);  // 冷库无持久化行

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });

    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current?.fiveHour?.utilization).toBe(10);
    // 且已正常落库 (INSERT 被调用)
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('serializes concurrent records behind one hydration read (stale row must not win)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    const dbRead = deferred<{ snapshot: string } | null>();
    mocks.queryOne.mockReturnValue(dbRead.promise);

    // 冷缓存: 两笔 headers 快照并发到达 (5h=10% → 5h=20%), SQLite 读挂起中。
    const recordA = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    const recordB = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 20 }, source: 'unified-headers', updatedAt: 2,
    });

    // 持久化里躺着上个周期的旧行 (5h=5%) —— 读回后不得覆盖两笔新数据。
    dbRead.resolve({
      snapshot: JSON.stringify({ fiveHour: { utilization: 5 }, source: 'oauth-endpoint', updatedAt: 0 }),
    });
    await Promise.all([recordA, recordB]);

    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current?.fiveHour?.utilization).toBe(20);
    expect(current?.updatedAt).toBe(2);
  });

  it('discards an in-flight hydration result when clear wins the race', async () => {
    const broadcaster = await import('../usageBroadcaster');
    const dbRead = deferred<{ snapshot: string } | null>();
    mocks.queryOne.mockReturnValue(dbRead.promise);

    // record 触发冷缓存 hydration (挂起) → clear 抢先完成。
    const record = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    await broadcaster.clearClaudeSubscriptionUsageSnapshot();

    dbRead.resolve({
      snapshot: JSON.stringify({ fiveHour: { utilization: 99 }, source: 'oauth-endpoint', updatedAt: 0 }),
    });
    await record;

    // clear 抢先后: hydration 读回的旧持久化行 (5h=99%) 不得复活, 且 record 本身
    // 也因世代复查被整体丢弃 (不 merge / 不广播 / 不写库) —— 快照保持 null。
    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current).toBeNull();
  });
});
