/**
 * claudeSubscriptionUsageRefresh.test.ts
 * ---------------------------------------------------------------------------
 * cached-first reader 的行为单测:
 *   - read(): 缓存立即返回 + 后台刷新;无凭证时清一次缓存(且只清一次)
 *   - 节流: throttleMs 内重复触发不再 fetch; token 变化重置节流
 *   - 401 → 清缓存快照; 429 → 指数退避(初始 → ×2 → 封顶), 成功后重置
 */

import { describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import {
  createClaudeSubscriptionUsageReader,
  type ClaudeSubscriptionCredentialInfo,
} from '../claudeSubscriptionUsageRefresh';

class UnauthorizedError extends Error {}
class RateLimitedError extends Error {}

function makeSnapshot(updatedAt: number): ClaudeSubscriptionUsageSnapshot {
  return { fiveHour: { utilization: 10 }, source: 'oauth-endpoint', updatedAt };
}

function makeDeps(overrides: Partial<{
  credentials: ClaudeSubscriptionCredentialInfo | null;
  cached: ClaudeSubscriptionUsageSnapshot | null;
  now: () => number;
  fetchSnapshot: ReturnType<typeof vi.fn>;
}> = {}) {
  const recordSnapshot = vi.fn().mockResolvedValue(undefined);
  const clearSnapshot = vi.fn().mockResolvedValue(undefined);
  const fetchSnapshot = overrides.fetchSnapshot
    ?? vi.fn().mockResolvedValue(makeSnapshot(1));
  const deps = {
    readCredentials: vi.fn(() => overrides.credentials === undefined
      ? { accessToken: 'token-a', subscriptionType: 'max' }
      : overrides.credentials),
    fetchSnapshot,
    recordSnapshot,
    clearSnapshot,
    readCachedSnapshot: vi.fn().mockResolvedValue(overrides.cached ?? null),
    fingerprintToken: (token: string) => `fp:${token}`,
    now: overrides.now ?? (() => 1_000_000),
    isUnauthorizedError: (err: unknown) => err instanceof UnauthorizedError,
    isRateLimitedError: (err: unknown) => err instanceof RateLimitedError,
    onRefreshError: vi.fn(),
  };
  return { deps, recordSnapshot, clearSnapshot, fetchSnapshot };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createClaudeSubscriptionUsageReader', () => {
  it('returns the cached snapshot immediately and refreshes in the background', async () => {
    const cached = makeSnapshot(0);
    const fresh = makeSnapshot(2);
    const { deps, recordSnapshot } = makeDeps({
      cached,
      fetchSnapshot: vi.fn().mockResolvedValue(fresh),
    });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await expect(reader.read()).resolves.toBe(cached);
    await settle();
    // 归属指纹由 reader 在 record 前附加(fetch 时 token 已在手, 不再读凭证库)。
    expect(recordSnapshot).toHaveBeenCalledWith({ ...fresh, accountFingerprint: 'fp:token-a' });
  });

  it('clears the snapshot once when credentials disappear', async () => {
    let credentials: ClaudeSubscriptionCredentialInfo | null = { accessToken: 'token-a' };
    const { deps, clearSnapshot } = makeDeps();
    deps.readCredentials = vi.fn(() => credentials);
    const reader = createClaudeSubscriptionUsageReader(deps);

    await reader.read();
    credentials = null;
    await expect(reader.read()).resolves.toBeNull();
    await expect(reader.read()).resolves.toBeNull();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    // 未登录用户的常规读不触发清库
    const freshDeps = makeDeps({ credentials: null });
    const freshReader = createClaudeSubscriptionUsageReader(freshDeps.deps);
    await expect(freshReader.read()).resolves.toBeNull();
    expect(freshDeps.clearSnapshot).not.toHaveBeenCalled();
  });

  it('throttles refreshes within throttleMs and resets on token change', async () => {
    let nowMs = 1_000_000;
    let token = 'token-a';
    const { deps, fetchSnapshot } = makeDeps({ now: () => nowMs });
    deps.readCredentials = vi.fn(() => ({ accessToken: token }));
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    await reader.read();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 10_000;
    await reader.read();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);  // 节流内不再 fetch

    nowMs += 180_001;
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);  // 节流过期后触发

    token = 'token-b';
    nowMs += 1_000;
    await reader.read();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);  // token 变化重置节流
  });

  it('clears the cached snapshot on unauthorized errors but keeps the throttle', async () => {
    let nowMs = 1_000_000;
    const fetchSnapshot = vi.fn().mockRejectedValue(new UnauthorizedError('401'));
    const { deps, clearSnapshot, recordSnapshot } = makeDeps({ now: () => nowMs, fetchSnapshot });
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });
    await reader.read();
    await settle();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(recordSnapshot).not.toHaveBeenCalled();
    expect(deps.onRefreshError).not.toHaveBeenCalled();

    // token 过期但仍在凭证库的窗口: 节流必须保留, 每个 turn-done 不得对敏感端点
    // 无节流重试 401。
    nowMs += 10_000;
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 180_001;  // 节流过期后允许再试
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially on 429 and recovers after a success', async () => {
    let nowMs = 1_000_000;
    const fetchSnapshot = vi.fn()
      .mockRejectedValueOnce(new RateLimitedError('429'))
      .mockRejectedValueOnce(new RateLimitedError('429'))
      .mockResolvedValue(makeSnapshot(9));
    const { deps, recordSnapshot } = makeDeps({ now: () => nowMs, fetchSnapshot });
    const reader = createClaudeSubscriptionUsageReader(deps, {
      throttleMs: 1_000,
      rateLimitBackoffInitialMs: 300_000,
      rateLimitBackoffMaxMs: 1_800_000,
    });

    reader.triggerRefresh();  // 第一次 → 429, 退避 300s
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 200_000;  // 退避未过
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 200_000;  // 退避已过 → 第二次 → 429, 退避 ×2 = 600s
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    nowMs += 500_000;  // 600s 未过
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    nowMs += 200_000;  // 已过 → 第三次成功, 退避清零
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(recordSnapshot).toHaveBeenCalledWith({ ...makeSnapshot(9), accountFingerprint: 'fp:token-a' });

    nowMs += 1_001;  // 常规节流恢复生效
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);
  });

  it('invalidates the persisted snapshot when its fingerprint belongs to another token', async () => {
    // 同机换号:持久化快照归属 token-b, 当前凭证是 token-a → read 不得把上一个
    // 账号的余量顶给新账号, 应清缓存 + 返回 null + 触发后台刷新。
    const staleSnapshot = { ...makeSnapshot(1), accountFingerprint: 'fp:token-b' };
    const { deps, clearSnapshot, fetchSnapshot } = makeDeps({ cached: staleSnapshot });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await expect(reader.read()).resolves.toBeNull();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps serving fingerprint-less legacy snapshots (unknown ownership, do not over-clear)', async () => {
    const legacy = makeSnapshot(1);  // 无 accountFingerprint
    const { deps, clearSnapshot } = makeDeps({ cached: legacy });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await expect(reader.read()).resolves.toBe(legacy);
    expect(clearSnapshot).not.toHaveBeenCalled();
  });

  it('skips the credential read entirely when triggerRefresh hits throttle / backoff / in-flight', async () => {
    // turn-done 每轮无条件触发, 预检必须在读凭证之前 —— macOS 的凭证读是同步
    // keychain 子进程 spawn, 节流窗口内不允许为"短路判断"付这笔成本。
    let nowMs = 1_000_000;
    const { deps, fetchSnapshot } = makeDeps({ now: () => nowMs });
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    // 首次触发 2 次读: trigger 入口 1 次 + fetch 成功后的 isRefreshStillCurrent 校验
    // (后者在后台 async 流程里, 不在 turn-done 同步路径上)。
    const baseline = deps.readCredentials.mock.calls.length;

    nowMs += 10_000;  // 节流窗口内
    reader.triggerRefresh();
    reader.triggerRefresh();
    await settle();
    expect(deps.readCredentials).toHaveBeenCalledTimes(baseline);  // 预检短路, 零凭证读
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('cools down credential probing after a no-credentials result (gateway-only users)', async () => {
    // 未连订阅用户: turn-done 每轮无条件触发, 读到 null 后 throttleMs 内不得再付
    // 同步 keychain 读; 冷却过期后恢复探测 (外部 cc CLI 登录最迟一个窗口被拾起)。
    let nowMs = 1_000_000;
    const { deps, fetchSnapshot } = makeDeps({ credentials: null, now: () => nowMs });
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    reader.triggerRefresh();
    expect(deps.readCredentials).toHaveBeenCalledTimes(1);

    nowMs += 10_000;  // 冷却窗口内: 零凭证读
    reader.triggerRefresh();
    reader.triggerRefresh();
    expect(deps.readCredentials).toHaveBeenCalledTimes(1);

    nowMs += 180_001;  // 冷却过期 → 恢复探测
    reader.triggerRefresh();
    expect(deps.readCredentials).toHaveBeenCalledTimes(2);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('read() observing no credentials also arms the probe cooldown for turn-done triggers', async () => {
    let nowMs = 1_000_000;
    const { deps } = makeDeps({ credentials: null, now: () => nowMs });
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    await expect(reader.read()).resolves.toBeNull();
    const baseline = deps.readCredentials.mock.calls.length;
    nowMs += 10_000;
    reader.triggerRefresh();
    expect(deps.readCredentials).toHaveBeenCalledTimes(baseline);
  });

  it('lifts the no-credentials cooldown on an auth-change sync (login is picked up immediately)', async () => {
    let nowMs = 1_000_000;
    let credentials: ClaudeSubscriptionCredentialInfo | null = null;
    const { deps, fetchSnapshot } = makeDeps({ now: () => nowMs });
    deps.readCredentials = vi.fn(() => credentials);
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    reader.triggerRefresh();  // null → 冷却武装
    expect(fetchSnapshot).not.toHaveBeenCalled();

    credentials = { accessToken: 'token-a' };
    nowMs += 1_000;  // 冷却未过, 但登录钩子不吃冷却 → 立即端点刷新
    await reader.syncForCredentialChange();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 200_000;  // 冷却已解除, 常规节流过期后 turn-done 正常触发
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('clears the cache on successful-but-empty fetches without resetting the throttle', async () => {
    // 教育版 / schema 变化: 端点 2xx 但无可解析窗口 → 清缓存降级为无数据 (不展示
    // 过期值); 节流状态保留, 不会退化成每次 turn-done 都打一次端点。
    let nowMs = 1_000_000;
    const fetchSnapshot = vi.fn().mockResolvedValue('empty');
    const { deps, clearSnapshot, recordSnapshot } = makeDeps({
      now: () => nowMs,
      fetchSnapshot,
      cached: makeSnapshot(1),
    });
    const reader = createClaudeSubscriptionUsageReader(deps, { throttleMs: 180_000 });

    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(recordSnapshot).not.toHaveBeenCalled();

    nowMs += 10_000;  // 节流窗口内不再打端点
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('syncForCredentialChange clears persisted snapshots even on cold logout', async () => {
    // app 启动后首个 OAuth 操作是登出: 本进程从未观察过凭证(hadCredentials=false),
    // read() 的守卫不会清 —— 强制同步必须无条件清磁盘残留并广播 null。
    const { deps, clearSnapshot } = makeDeps({ credentials: null, cached: makeSnapshot(1) });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await reader.syncForCredentialChange();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
  });

  it('syncForCredentialChange clears the old-account snapshot and refreshes for the new token', async () => {
    const stale = { ...makeSnapshot(1), accountFingerprint: 'fp:token-old' };
    const { deps, clearSnapshot, fetchSnapshot } = makeDeps({ cached: stale });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await reader.syncForCredentialChange();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'token-a' }));
  });

  it('syncForCredentialChange keeps the matching-account snapshot and just refreshes', async () => {
    const owned = { ...makeSnapshot(1), accountFingerprint: 'fp:token-a' };
    const { deps, clearSnapshot, fetchSnapshot } = makeDeps({ cached: owned });
    const reader = createClaudeSubscriptionUsageReader(deps);

    await reader.syncForCredentialChange();
    expect(clearSnapshot).not.toHaveBeenCalled();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('drops the fetched snapshot if the token changed mid-flight', async () => {
    let token = 'token-a';
    const fetchDeferred: { resolve?: (v: ClaudeSubscriptionUsageSnapshot) => void } = {};
    const fetchSnapshot = vi.fn().mockImplementation(() =>
      new Promise<ClaudeSubscriptionUsageSnapshot>((resolve) => { fetchDeferred.resolve = resolve; }));
    const { deps, recordSnapshot } = makeDeps({ fetchSnapshot });
    deps.readCredentials = vi.fn(() => ({ accessToken: token }));
    const reader = createClaudeSubscriptionUsageReader(deps);

    reader.triggerRefresh();
    token = 'token-b';
    fetchDeferred.resolve?.(makeSnapshot(5));
    await settle();
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it('queues a follow-up refresh for the new token when a fetch is in flight during account switch', async () => {
    // in-flight 换号:旧 token 的响应被丢弃后, 必须自动为新 token 补一次端点刷新,
    // 否则 scoped 分模型窗口 / extra usage 等端点独有字段要空到下一次外部触发。
    let token = 'token-a';
    const deferred: Array<(v: ClaudeSubscriptionUsageSnapshot) => void> = [];
    const fetchSnapshot = vi.fn().mockImplementation(() =>
      new Promise<ClaudeSubscriptionUsageSnapshot>((resolve) => { deferred.push(resolve); }));
    const { deps, recordSnapshot } = makeDeps({ fetchSnapshot });
    deps.readCredentials = vi.fn(() => ({ accessToken: token }));
    const reader = createClaudeSubscriptionUsageReader(deps);

    reader.triggerRefresh();                    // token-a fetch 在飞
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    token = 'token-b';
    // followup 排队走完整路径(read / auth 钩子); turn-done 的 triggerRefresh 在
    // in-flight 时预检短路(刷新已在进行), 不承担换号 followup。
    void reader.read();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    deferred[0]?.(makeSnapshot(5));             // 旧响应回来 → 被丢弃
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(fetchSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'token-b' }));

    deferred[1]?.(makeSnapshot(7));             // 新 token 的响应正常落库
    await settle();
    expect(recordSnapshot).toHaveBeenCalledTimes(1);
    expect(recordSnapshot).toHaveBeenCalledWith({ ...makeSnapshot(7), accountFingerprint: 'fp:token-b' });
  });
});
