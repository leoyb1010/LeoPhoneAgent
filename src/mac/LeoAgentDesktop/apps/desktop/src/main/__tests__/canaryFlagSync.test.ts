import { describe, expect, it, vi } from 'vitest';
import {
  syncCanaryFlagAfterAuth,
  type CanaryFlagSyncDeps,
  type FeatureFlagsFetchResult,
} from '../canaryFlagSync';

const REQUEST = {
  token: 'access-token',
  expectedAuthEpoch: 7,
  expectedUserId: 'user-1',
};

/** Builds deterministic dependencies for one canary synchronization test. */
function makeDeps(
  result: FeatureFlagsFetchResult,
  current: { authEpoch: number; userId: string | null } = {
    authEpoch: REQUEST.expectedAuthEpoch,
    userId: REQUEST.expectedUserId,
  },
): CanaryFlagSyncDeps & { persistFlag: ReturnType<typeof vi.fn> } {
  return {
    fetchFeatureFlags: vi.fn().mockResolvedValue(result),
    readCurrentAuthIdentity: vi.fn(() => current),
    persistFlag: vi.fn(),
  };
}

describe('syncCanaryFlagAfterAuth', () => {
  it.each([true, false])('persists a valid isCanary=%s response', async (isCanary) => {
    const deps = makeDeps({ ok: true, status: 200, data: { isCanary } });

    await expect(syncCanaryFlagAfterAuth(REQUEST, deps)).resolves.toEqual({
      kind: 'synced',
      isCanary,
    });
    expect(deps.fetchFeatureFlags).toHaveBeenCalledWith(REQUEST.token);
    expect(deps.persistFlag).toHaveBeenCalledWith(isCanary);
  });

  it('preserves the existing flag when the server request fails', async () => {
    const deps = makeDeps({
      ok: false,
      status: 503,
      data: { error: { code: 'SERVICE_UNAVAILABLE' } },
    });

    await expect(syncCanaryFlagAfterAuth(REQUEST, deps)).resolves.toEqual({
      kind: 'preserved',
      reason: 'request-failed',
      status: 503,
    });
    expect(deps.persistFlag).not.toHaveBeenCalled();
  });

  it('preserves the existing flag when the request throws', async () => {
    const deps = makeDeps({ ok: true, status: 200, data: { isCanary: true } });
    vi.mocked(deps.fetchFeatureFlags).mockRejectedValueOnce(new Error('offline'));

    await expect(syncCanaryFlagAfterAuth(REQUEST, deps)).resolves.toEqual({
      kind: 'preserved',
      reason: 'request-failed',
      status: 0,
    });
    expect(deps.persistFlag).not.toHaveBeenCalled();
  });

  it.each([null, {}, { isCanary: 'true' }, { isCanary: 1 }])(
    'preserves the existing flag for an invalid response: %j',
    async (data) => {
      const deps = makeDeps({ ok: true, status: 200, data });

      await expect(syncCanaryFlagAfterAuth(REQUEST, deps)).resolves.toEqual({
        kind: 'preserved',
        reason: 'invalid-response',
        status: 200,
      });
      expect(deps.persistFlag).not.toHaveBeenCalled();
    },
  );

  it.each([
    { authEpoch: REQUEST.expectedAuthEpoch + 1, userId: REQUEST.expectedUserId },
    { authEpoch: REQUEST.expectedAuthEpoch, userId: 'user-2' },
    { authEpoch: REQUEST.expectedAuthEpoch, userId: null },
  ])('discards a valid response after auth changes: %j', async (current) => {
    const deps = makeDeps({ ok: true, status: 200, data: { isCanary: true } }, current);

    await expect(syncCanaryFlagAfterAuth(REQUEST, deps)).resolves.toEqual({
      kind: 'preserved',
      reason: 'stale-auth',
    });
    expect(deps.persistFlag).not.toHaveBeenCalled();
  });
});
