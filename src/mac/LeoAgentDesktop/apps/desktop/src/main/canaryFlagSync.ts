/**
 * Coordinates the authenticated feature-flags lookup with local canary state.
 *
 * The network and persistence operations are injected so the race-sensitive
 * policy stays deterministic and can be tested without Electron.
 */

/** Minimal result shape returned by the authenticated feature-flags request. */
export interface FeatureFlagsFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Authentication identity captured when a feature-flags sync is scheduled. */
export interface CanaryFlagSyncRequest {
  token: string;
  expectedAuthEpoch: number;
  expectedUserId: string;
}

/** Runtime dependencies for one feature-flags synchronization attempt. */
export interface CanaryFlagSyncDeps {
  fetchFeatureFlags(token: string): Promise<FeatureFlagsFetchResult>;
  readCurrentAuthIdentity(): { authEpoch: number; userId: string | null };
  persistFlag(isCanary: boolean): void;
}

/** Observable result used by the caller for structured logging. */
export type CanaryFlagSyncOutcome =
  | { kind: 'synced'; isCanary: boolean }
  | {
      kind: 'preserved';
      reason: 'request-failed' | 'invalid-response' | 'stale-auth';
      status?: number;
    };

/**
 * Fetches the current user's canary flag and persists it only while the same
 * authentication generation is still active.
 *
 * Request failures and malformed responses deliberately preserve the existing
 * local value. That value selects the update channel before login recovery on
 * the next launch, so clearing it on a transient failure would silently
 * downgrade an existing canary user.
 */
export async function syncCanaryFlagAfterAuth(
  request: CanaryFlagSyncRequest,
  deps: CanaryFlagSyncDeps,
): Promise<CanaryFlagSyncOutcome> {
  let result: FeatureFlagsFetchResult;
  try {
    result = await deps.fetchFeatureFlags(request.token);
  } catch {
    return { kind: 'preserved', reason: 'request-failed', status: 0 };
  }

  if (!result.ok) {
    return { kind: 'preserved', reason: 'request-failed', status: result.status };
  }

  const isCanary =
    result.data && typeof result.data === 'object'
      ? (result.data as { isCanary?: unknown }).isCanary
      : undefined;
  if (typeof isCanary !== 'boolean') {
    return { kind: 'preserved', reason: 'invalid-response', status: result.status };
  }

  const current = deps.readCurrentAuthIdentity();
  if (
    current.authEpoch !== request.expectedAuthEpoch ||
    current.userId !== request.expectedUserId
  ) {
    return { kind: 'preserved', reason: 'stale-auth' };
  }

  deps.persistFlag(isCanary);
  return { kind: 'synced', isCanary };
}
