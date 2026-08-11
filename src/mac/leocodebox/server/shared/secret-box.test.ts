import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Isolate the persisted key file to a temp dir so the test never touches the
// real ~/.leocodebox and stays deterministic across machines.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-box-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'auth.db');
delete process.env.LEOCODEBOX_PROVIDER_KEY_SECRET;

const { encryptSecret, decryptSecret, isEncrypted } = await import('./secret-box.js');

test('round-trips a value and marks it encrypted', () => {
  const encrypted = encryptSecret('ghp_secret_token');
  assert.match(encrypted, /^enc:v1:/);
  assert.ok(isEncrypted(encrypted));
  assert.equal(decryptSecret(encrypted), 'ghp_secret_token');
});

test('persists a random 0600 key file (no deterministic derivation)', () => {
  encryptSecret('x');
  const keyFile = path.join(tmpDir, 'secret-box.key');
  assert.ok(fs.existsSync(keyFile));
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

test('empty and plaintext values pass through untouched', () => {
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');
  assert.equal(decryptSecret('legacy-plaintext'), 'legacy-plaintext');
  assert.equal(isEncrypted('legacy-plaintext'), false);
});

test('decrypts ciphertext written under the legacy deterministic key', () => {
  // Reproduce the pre-secret-box format: sha256(username:homedir:leocodebox).
  const legacyKey = crypto.createHash('sha256')
    .update(`${os.userInfo().username}:${os.homedir()}:leocodebox`)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  const ct = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
  assert.equal(decryptSecret(blob), 'legacy-secret');
});
