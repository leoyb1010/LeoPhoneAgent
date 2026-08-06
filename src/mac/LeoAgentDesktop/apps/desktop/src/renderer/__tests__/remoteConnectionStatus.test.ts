/**
 * remoteConnectionStatus.test.ts —— 远程会话连接状态派生(控制端 banner 依据)。
 * 本机链路非 online 优先级最高(reconnecting);本机在线但被控端离线 → host-offline;都在线 → connected。
 */
import { describe, it, expect } from 'vitest';

import { deriveRemoteConnectionStatus } from '@/features/cc-agent/hooks/useRemoteSessionConnection';

describe('deriveRemoteConnectionStatus', () => {
  it('本机链路非 online → reconnecting(优先级最高,与被控端在线与否无关)', () => {
    expect(deriveRemoteConnectionStatus('connecting', true)).toBe('reconnecting');
    expect(deriveRemoteConnectionStatus('stopped', true)).toBe('reconnecting');
    expect(deriveRemoteConnectionStatus('connecting', false)).toBe('reconnecting');
  });
  it('本机 online + 被控端离线 → host-offline', () => {
    expect(deriveRemoteConnectionStatus('online', false)).toBe('host-offline');
  });
  it('本机 online + 被控端在线 → connected', () => {
    expect(deriveRemoteConnectionStatus('online', true)).toBe('connected');
  });
});
