/**
 * subscriptionRefcount 单测 —— 控制端多窗口订阅引用计数。
 * 守住「关一个窗口不拆掉其它窗口还在用的订阅」这条核心安全性。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordSubscribe,
  recordUnsubscribe,
  recordWindowGone,
  resetAll,
  __testing,
} from '../device-link/subscriptionRefcount';

afterEach(() => resetAll());

describe('subscriptionRefcount', () => {
  it('subscribe 恒转发全部 topics(幂等),去重', () => {
    expect(recordSubscribe(1, 'devA', ['sessions', 'sessions'])).toEqual(['sessions']);
    expect(recordSubscribe(1, 'devA', ['session:s1'])).toEqual(['session:s1']);
    expect(__testing.refCount('devA', 'sessions')).toBe(1);
  });

  it('两窗口订阅同 (device, topic):前一个 unsubscribe 不降零,后一个才降零', () => {
    recordSubscribe(1, 'devA', ['sessions']);
    recordSubscribe(2, 'devA', ['sessions']);
    expect(__testing.refCount('devA', 'sessions')).toBe(2);

    // 窗口 1 取消:仍有窗口 2 持有 → 不降零 → 不转发 unsubscribe
    expect(recordUnsubscribe(1, 'devA', ['sessions'])).toEqual([]);
    expect(__testing.refCount('devA', 'sessions')).toBe(1);

    // 窗口 2 取消:最后一个 → 降零 → 转发 unsubscribe
    expect(recordUnsubscribe(2, 'devA', ['sessions'])).toEqual(['sessions']);
    expect(__testing.refCount('devA', 'sessions')).toBe(0);
  });

  it('幂等去重:同窗口重复 subscribe 不叠加计数', () => {
    recordSubscribe(1, 'devA', ['sessions']);
    recordSubscribe(1, 'devA', ['sessions']);
    expect(__testing.refCount('devA', 'sessions')).toBe(1);
    expect(recordUnsubscribe(1, 'devA', ['sessions'])).toEqual(['sessions']); // 一次取消即降零
  });

  it('从未记录的 topic 取消 → 视作降零返回(保持总转发幂等语义)', () => {
    expect(recordUnsubscribe(9, 'ghost', ['session:x'])).toEqual(['session:x']);
  });

  it('recordWindowGone:释放该窗口全部引用,按 device 聚合降零;其它窗口持有的不降零', () => {
    recordSubscribe(1, 'devA', ['sessions', 'session:s1']);
    recordSubscribe(2, 'devA', ['sessions']); // devA/sessions 被两窗口持有
    recordSubscribe(1, 'devB', ['sessions']);

    const gone = recordWindowGone(1);
    // devA:sessions 仍有窗口 2 → 不降零;session:s1 仅窗口 1 → 降零。devB:sessions 仅窗口 1 → 降零。
    const byDevice = Object.fromEntries(gone.map((g) => [g.deviceId, g.topics.sort()]));
    expect(byDevice['devA']).toEqual(['session:s1']);
    expect(byDevice['devB']).toEqual(['sessions']);
    expect(__testing.refCount('devA', 'sessions')).toBe(1); // 窗口 2 还在
    expect(__testing.refCount('devA', 'session:s1')).toBe(0);
    expect(__testing.refCount('devB', 'sessions')).toBe(0);
  });

  it('recordWindowGone 对没有任何订阅的窗口 → 空数组', () => {
    recordSubscribe(1, 'devA', ['sessions']);
    expect(recordWindowGone(42)).toEqual([]);
  });

  it('snapshotSubscriptions 返回当前逻辑订阅,供重连后重放', () => {
    recordSubscribe(1, 'devA', ['sessions', 'session:s1']);
    recordSubscribe(2, 'devA', ['sessions']);
    recordSubscribe(3, 'devB', ['session:s2']);

    const all = Object.fromEntries(
      __testing.snapshotSubscriptions().map((item) => [item.deviceId, item.topics.sort()]),
    );
    expect(all).toEqual({
      devA: ['session:s1', 'sessions'],
      devB: ['session:s2'],
    });

    expect(__testing.snapshotSubscriptions('devA')).toEqual([
      { deviceId: 'devA', topics: ['sessions', 'session:s1'] },
    ]);
  });

  it('resetAll 清空所有引用', () => {
    recordSubscribe(1, 'devA', ['sessions']);
    recordSubscribe(2, 'devB', ['session:s1']);
    resetAll();
    expect(__testing.refCount('devA', 'sessions')).toBe(0);
    expect(__testing.refCount('devB', 'session:s1')).toBe(0);
  });
});
