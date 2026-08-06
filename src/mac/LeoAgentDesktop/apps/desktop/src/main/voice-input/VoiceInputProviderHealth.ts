import { createLogger } from '../logger.js';

const log = createLogger('voice-input:provider-health');

/**
 * In-memory sticky-failover registry shared by the ASR and refiner fallback
 * wrappers.
 *
 * A provider that failed to connect (or whose recovery was exhausted) enters a
 * cooldown window. While cooling down it is not removed from the fallback
 * chain — it is only moved behind healthy candidates, so when every candidate
 * is unhealthy we still try them instead of refusing to start. State is
 * intentionally process-local and not persisted: an app restart is a natural
 * "try the primary again" point.
 */
const VOICE_INPUT_PROVIDER_COOLDOWN_MS = 30 * 60_000;

type ProviderHealthEntry = {
  failedAt: number;
  reason: string;
};

const failuresByKey = new Map<string, ProviderHealthEntry>();

/** Namespaces keep ASR and refiner profile ids from colliding in the registry. */
export type VoiceInputProviderHealthScope = 'asr' | 'refiner';

function healthKey(scope: VoiceInputProviderHealthScope, providerId: string): string {
  return `${scope}:${providerId}`;
}

export function markVoiceInputProviderFailure(
  scope: VoiceInputProviderHealthScope,
  providerId: string,
  reason: string,
): void {
  failuresByKey.set(healthKey(scope, providerId), { failedAt: Date.now(), reason });
  log.warn('voice input provider entered failover cooldown', {
    scope,
    providerId,
    cooldownMs: VOICE_INPUT_PROVIDER_COOLDOWN_MS,
    reason,
  });
}

export function markVoiceInputProviderSuccess(
  scope: VoiceInputProviderHealthScope,
  providerId: string,
): void {
  if (failuresByKey.delete(healthKey(scope, providerId))) {
    log.info('voice input provider recovered from failover cooldown', { scope, providerId });
  }
}

export function isVoiceInputProviderCoolingDown(
  scope: VoiceInputProviderHealthScope,
  providerId: string,
): boolean {
  const entry = failuresByKey.get(healthKey(scope, providerId));
  if (!entry) return false;
  if (Date.now() - entry.failedAt >= VOICE_INPUT_PROVIDER_COOLDOWN_MS) {
    failuresByKey.delete(healthKey(scope, providerId));
    return false;
  }
  return true;
}

/**
 * Stable-partitions a fallback chain: healthy providers first (original order
 * preserved), cooling-down providers appended at the end as a last resort.
 */
export function orderVoiceInputProvidersByHealth<K extends string>(
  scope: VoiceInputProviderHealthScope,
  chain: readonly K[],
): K[] {
  const healthy: K[] = [];
  const coolingDown: K[] = [];
  for (const providerId of chain) {
    (isVoiceInputProviderCoolingDown(scope, providerId) ? coolingDown : healthy).push(providerId);
  }
  return [...healthy, ...coolingDown];
}

/** Test-only helper: clears all cooldown state between cases. */
export function resetVoiceInputProviderHealthForTests(): void {
  failuresByKey.clear();
}
