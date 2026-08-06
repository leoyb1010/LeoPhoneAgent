import { describe, expect, it } from 'vitest';

import { resolveClearSessionBoundary } from '../clearSessionBoundary.js';

describe('resolveClearSessionBoundary', () => {
  it('本机 clear 使用 renderer 传入的 clearedAt 边界', () => {
    expect(resolveClearSessionBoundary({
      clearedAt: '2026-06-21T01:02:03.000Z',
      isRemoteInvoke: false,
      nowMs: 1782010000000,
    })).toBe('2026-06-21T01:02:03.000Z');
  });

  it('device-link remote clear 使用被控端当前时间作为权威边界', () => {
    expect(resolveClearSessionBoundary({
      clearedAt: '2026-06-20T01:02:03.000Z',
      isRemoteInvoke: true,
      nowMs: 1782010000000,
    })).toBe(1782010000000);
  });
});
