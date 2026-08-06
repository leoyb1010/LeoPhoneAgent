/**
 * revokedDevicesStore 单测:控制端「已撤销」标记的 mark/clear/all + 快照引用稳定性
 * (useSyncExternalStore 依赖:内容不变时 getSnapshot 返回同一引用,变化时才换新)。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';

beforeEach(() => {
  revokedDevicesStore.clearAll();
});

describe('revokedDevicesStore', () => {
  it('mark / has / clear 基本语义', () => {
    expect(revokedDevicesStore.has('dev-1')).toBe(false);
    revokedDevicesStore.markRevoked('dev-1');
    expect(revokedDevicesStore.has('dev-1')).toBe(true);
    expect(revokedDevicesStore.getSnapshot().has('dev-1')).toBe(true);
    revokedDevicesStore.clearRevoked('dev-1');
    expect(revokedDevicesStore.has('dev-1')).toBe(false);
  });

  it('快照引用:内容不变(重复 mark / clear 不存在项)不换引用;变化才换', () => {
    const s0 = revokedDevicesStore.getSnapshot();
    revokedDevicesStore.clearRevoked('absent'); // 不存在 → 无变化
    expect(revokedDevicesStore.getSnapshot()).toBe(s0);

    revokedDevicesStore.markRevoked('dev-1');
    const s1 = revokedDevicesStore.getSnapshot();
    expect(s1).not.toBe(s0);
    revokedDevicesStore.markRevoked('dev-1'); // 幂等 → 不换引用
    expect(revokedDevicesStore.getSnapshot()).toBe(s1);
  });

  it('subscribe 在内容变化时收到通知;clearAll 一次性清空', () => {
    let n = 0;
    const off = revokedDevicesStore.subscribe(() => {
      n += 1;
    });
    revokedDevicesStore.markRevoked('a');
    revokedDevicesStore.markRevoked('b');
    revokedDevicesStore.markRevoked('a'); // 幂等 → 不通知
    expect(n).toBe(2);
    revokedDevicesStore.clearAll();
    expect(revokedDevicesStore.has('a')).toBe(false);
    expect(revokedDevicesStore.has('b')).toBe(false);
    expect(n).toBe(3);
    off();
    revokedDevicesStore.markRevoked('c'); // 已退订 → 不再增
    expect(n).toBe(3);
  });
});
