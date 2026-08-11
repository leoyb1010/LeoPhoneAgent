/**
 * Symmetric secret box for at-rest encryption of sensitive values kept in the
 * local SQLite database — external-service credentials (GitHub/GitLab tokens),
 * the JWT signing secret, the browser MCP token. AES-256-GCM with a random
 * per-value IV. Ciphertext is self-describing via the `enc:v1:` prefix, so a
 * plaintext legacy value passes through untouched and is upgraded on next write.
 *
 * Key provisioning, in priority order:
 *   1. LEOCODEBOX_PROVIDER_KEY_SECRET — set by the desktop shell after sealing a
 *      random key with the OS keychain (safeStorage). This is the shipped path.
 *   2. A random 32-byte key persisted 0600 next to the database — used when the
 *      server runs outside the desktop shell (dev / standalone). Replaces the
 *      previous deterministic sha256(username:homedir) derivation, which any
 *      same-machine process could recompute.
 *
 * Decryption also tries the legacy deterministic key so values written by older
 * builds still decrypt; they re-encrypt under the current key on the next write.
 *
 * The `enc:v1:` format is shared with the provider store (provider-secrets),
 * which now delegates here, so provider secrets decrypt across both key regimes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'enc:v1:';

function keyFilePath(): string {
  const dbPath = process.env.DATABASE_PATH;
  const dir = dbPath ? path.dirname(dbPath) : path.join(os.homedir(), '.leocodebox');
  return path.join(dir, 'secret-box.key');
}

function persistedKey(): Buffer {
  const file = keyFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return Buffer.from(existing, 'hex');
  } catch { /* create below */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return key;
}

// Cache the resolved key, keyed by the inputs that select it, so a per-test
// DATABASE_PATH or a mid-process env change resolves to the right key.
let cache: { sig: string; key: Buffer } | null = null;

function primaryKey(): Buffer {
  const envSecret = process.env.LEOCODEBOX_PROVIDER_KEY_SECRET || '';
  const sig = `${envSecret}|${process.env.DATABASE_PATH || ''}`;
  if (cache?.sig === sig) return cache.key;
  const key = envSecret
    ? crypto.createHash('sha256').update(envSecret).digest()
    : persistedKey();
  cache = { sig, key };
  return key;
}

function legacyKey(): Buffer {
  return crypto.createHash('sha256')
    .update(`${os.userInfo().username}:${os.homedir()}:leocodebox`)
    .digest();
}

/** True when a stored value is already ciphertext produced by this module. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a plaintext value. No-op for empty strings and already-encrypted values. */
export function encryptSecret(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primaryKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function tryDecrypt(payload: string, key: Buffer): string | null {
  try {
    const [iv, tag, ciphertext] = payload.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Decrypt a value produced by encryptSecret. Plaintext (unprefixed) values pass
 * through unchanged so callers can read legacy rows. Returns '' when ciphertext
 * cannot be decrypted under any known key.
 */
export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const payload = value.slice(PREFIX.length);
  const result = tryDecrypt(payload, primaryKey()) ?? tryDecrypt(payload, legacyKey());
  return result ?? '';
}
