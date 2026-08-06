/**
 * useClaudeSubscriptionUsage 纯函数单测。
 *
 * resolvePersistedClaudeSubscriptionRead: mount 时 getClaudeSubscription 返回值的
 * 归一化 —— 关键回归是 null 必须映射为 'clear'(main 侧登出 / 换号指纹失配已清快照,
 * 若清除广播先于 hook 订阅发生, renderer 不清 module cache 会把上一个账号的余量
 * 一直顶在 chip 上)。
 */

import { describe, expect, it } from 'vitest';

import {
  reduceClaudeSubscriptionPush,
  resolvePersistedClaudeSubscriptionRead,
} from '../hooks/useClaudeSubscriptionUsage';

describe('resolvePersistedClaudeSubscriptionRead', () => {
  it('maps null to clear (main already dropped the snapshot; renderer must follow)', () => {
    expect(resolvePersistedClaudeSubscriptionRead(null)).toEqual({ action: 'clear' });
  });

  it('applies snapshot-shaped objects', () => {
    const snapshot = { fiveHour: { utilization: 10 }, source: 'oauth-endpoint' };
    expect(resolvePersistedClaudeSubscriptionRead(snapshot)).toEqual({
      action: 'apply',
      snapshot,
    });
  });

  it('ignores malformed payloads without touching current state', () => {
    expect(resolvePersistedClaudeSubscriptionRead(undefined)).toEqual({ action: 'ignore' });
    expect(resolvePersistedClaudeSubscriptionRead('nope')).toEqual({ action: 'ignore' });
    expect(resolvePersistedClaudeSubscriptionRead([1, 2])).toEqual({ action: 'ignore' });
  });
});

describe('reduceClaudeSubscriptionPush', () => {
  // module 常驻订阅与组件订阅共用: null 清空 (登出/换号广播, 即使所有 chip 已卸载
  // 也要清 module 缓存, 防止下次 mount seed 旧账号数据), 快照覆盖, 异常保留现状。
  const current = { fiveHour: { utilization: 10 } };

  it('clears on null broadcasts', () => {
    expect(reduceClaudeSubscriptionPush(current, null)).toBeNull();
  });

  it('replaces with pushed snapshots', () => {
    const next = { fiveHour: { utilization: 20 } };
    expect(reduceClaudeSubscriptionPush(current, next)).toBe(next);
  });

  it('keeps the current value on malformed payloads', () => {
    expect(reduceClaudeSubscriptionPush(current, 'garbage')).toBe(current);
    expect(reduceClaudeSubscriptionPush(current, undefined)).toBe(current);
  });
});
