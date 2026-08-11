/**
 * Provider-store secret encryption. Delegates to the shared secret box so the
 * provider store, user credentials, the JWT secret and the browser MCP token
 * all share one AES-256-GCM implementation and key regime.
 *
 * Historically this derived its key from sha256(username:homedir) when the
 * desktop-provisioned LEOCODEBOX_PROVIDER_KEY_SECRET was absent — a value any
 * same-machine process could recompute. That fallback now lives in secret-box
 * as a persisted random key (decrypt still tries the legacy derivation so old
 * ciphertext upgrades transparently).
 */
import { encryptSecret, decryptSecret } from '../../shared/secret-box.js';

export function encryptProviderSecret(value: string): string {
  return encryptSecret(value);
}

export function decryptProviderSecret(value: string): string {
  return decryptSecret(value);
}
