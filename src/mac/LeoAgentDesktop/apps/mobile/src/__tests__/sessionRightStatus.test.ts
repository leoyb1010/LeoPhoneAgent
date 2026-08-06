/**
 * sessionRightStatus.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖:会话行右侧状态槽五档优先级与桌面 sidebarRightStatus 对齐 ——
 * error 红 > awaiting TapTap 蓝 > running spinner > 完成未读绿 > 时间。
 */

import { describe, expect, it } from 'vitest';

import { resolveMobileSessionRightStatus } from '../session/sessionRightStatus';

const base = {
  liveAttention: false,
  livePhase: undefined,
  pendingInteractionCount: 0,
  running: false,
  scheduleUnreadCount: 0,
} as const;

describe('resolveMobileSessionRightStatus', () => {
  it('error 未读压过一切(含 running 与待处理交互)', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'error',
      pendingInteractionCount: 2,
      running: true,
      scheduleUnreadCount: 3,
    })).toBe('error');
  });

  it('error phase 但已读(attention=false)不亮红', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      livePhase: 'error',
    })).toBe('time');
  });

  it('awaiting 压过 running:实时待处理交互', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      pendingInteractionCount: 1,
      running: true,
    })).toBe('awaiting');
  });

  it('awaiting 也可由 liveActivity 未读 needs-interaction 点亮(relay 兜底)', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'needs-interaction',
    })).toBe('awaiting');
  });

  it('running 压过完成未读', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      running: true,
      scheduleUnreadCount: 1,
    })).toBe('running');
  });

  it('完成未读走 done:定时任务未读或 liveActivity 未读 completed', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      scheduleUnreadCount: 2,
    })).toBe('done');
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'completed',
    })).toBe('done');
  });

  it('无任何信号显示时间', () => {
    expect(resolveMobileSessionRightStatus(base)).toBe('time');
  });
});
