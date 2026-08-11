import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptProviderSecret, encryptProviderSecret } from '../provider-secrets.service.js';

test('provider secrets are encrypted at rest and round-trip', () => {
  const plaintext = 'sk-test-secret';
  const encrypted = encryptProviderSecret(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(decryptProviderSecret(encrypted), plaintext);
});

test('plain legacy provider secrets remain readable for migration', () => {
  assert.equal(decryptProviderSecret('legacy-key'), 'legacy-key');
});
