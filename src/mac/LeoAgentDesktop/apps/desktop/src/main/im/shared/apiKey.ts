/**
 * main/im/shared/apiKey.ts
 * ---------------------------------------------------------------------------
 * Read the user's XD Gateway API key from local safeStorage via the unified
 * providerSecretStore (本地 only,从不上云). Mirrors the same `api_key` storage
 * key the renderer's useApiKey hook / auth-adapters use.
 *
 * Used by `runAgentTurn` as a fast pre-check: if the user has not configured
 * an API key, we surface a friendly "go to Settings → Model Providers" prompt instead
 * of letting the claude-code SDK fail with a less-helpful error mid-stream.
 */

import { getProviderSecretStore } from '../../secrets/providerSecretStore.js';

/**
 * Read the user's XD Gateway API key. Returns null when not configured /
 * safeStorage unavailable / decrypt failed — the store swallows errors and
 * returns null, and the caller treats null as "not configured".
 */
export function readXdGatewayApiKey(): string | null {
  return getProviderSecretStore().get('xd');
}
