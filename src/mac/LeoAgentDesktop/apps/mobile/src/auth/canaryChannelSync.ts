/** 登录态 feature-flags 请求与本地 canary 快照之间的竞态安全协调器。 */

export interface CanarySyncRequest {
  token: string;
  expectedAuthGeneration: number;
}

export interface CanarySyncDeps {
  fetchFeatureFlags(token: string): Promise<unknown>;
  readCurrentAuthGeneration(): number;
  persistFlag(isCanary: boolean): Promise<void> | void;
}

export type CanarySyncOutcome =
  | { kind: 'synced'; isCanary: boolean }
  | { kind: 'preserved'; reason: 'request-failed' | 'invalid-response' | 'stale-auth' };

/** 请求失败/非法时保留旧值；登出或换账号后的迟到响应不得覆盖新身份。 */
export async function syncCanaryChannelAfterAuth(
  request: CanarySyncRequest,
  deps: CanarySyncDeps,
): Promise<CanarySyncOutcome> {
  let value: unknown;
  try {
    value = await deps.fetchFeatureFlags(request.token);
  } catch {
    return { kind: 'preserved', reason: 'request-failed' };
  }
  const isCanary = value && typeof value === 'object'
    ? (value as { isCanary?: unknown }).isCanary
    : undefined;
  if (typeof isCanary !== 'boolean') {
    return { kind: 'preserved', reason: 'invalid-response' };
  }
  if (deps.readCurrentAuthGeneration() !== request.expectedAuthGeneration) {
    return { kind: 'preserved', reason: 'stale-auth' };
  }
  await deps.persistFlag(isCanary);
  return { kind: 'synced', isCanary };
}
