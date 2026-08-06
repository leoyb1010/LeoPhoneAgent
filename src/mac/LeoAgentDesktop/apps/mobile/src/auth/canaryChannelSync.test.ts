import { describe, expect, it, vi } from 'vitest';

import { syncCanaryChannelAfterAuth } from './canaryChannelSync';

function deps(value: unknown, generation = 3) {
  return {
    fetchFeatureFlags: vi.fn(async () => value),
    readCurrentAuthGeneration: vi.fn(() => generation),
    persistFlag: vi.fn(async () => undefined),
  };
}

describe('syncCanaryChannelAfterAuth', () => {
  it.each([true, false])('合法 isCanary=%s 才持久化', async (isCanary) => {
    const d = deps({ isCanary });
    await expect(syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, d))
      .resolves.toEqual({ kind: 'synced', isCanary });
    expect(d.persistFlag).toHaveBeenCalledWith(isCanary);
  });

  it('请求失败/非法响应保留旧值', async () => {
    const failed = deps({});
    failed.fetchFeatureFlags.mockRejectedValueOnce(new Error('offline'));
    await expect(syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, failed))
      .resolves.toEqual({ kind: 'preserved', reason: 'request-failed' });
    expect(failed.persistFlag).not.toHaveBeenCalled();

    const invalid = deps({ isCanary: 'true' });
    await expect(syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, invalid))
      .resolves.toEqual({ kind: 'preserved', reason: 'invalid-response' });
    expect(invalid.persistFlag).not.toHaveBeenCalled();
  });

  it('登出/换账号后的迟到响应不得覆盖', async () => {
    const d = deps({ isCanary: true }, 4);
    await expect(syncCanaryChannelAfterAuth({ token: 'old', expectedAuthGeneration: 3 }, d))
      .resolves.toEqual({ kind: 'preserved', reason: 'stale-auth' });
    expect(d.persistFlag).not.toHaveBeenCalled();
  });
});
