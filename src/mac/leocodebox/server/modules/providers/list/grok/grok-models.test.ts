import assert from 'node:assert/strict';
import test from 'node:test';

import { GrokProviderModels, parseGrokModels } from './grok-models.provider.js';

test('parses the official grok models output without treating warnings as models', () => {
  const parsed = parseGrokModels(`WARN not authenticated
Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
  - grok-composer-2.5-fast`);
  assert.deepEqual(parsed, {
    ids: ['grok-4.6', 'grok-4.5', 'grok-composer-2.5-fast'],
    defaultId: 'grok-4.6',
  });
});

test('live discovery is merged with the offline 4.6 4.5 composer fallback', async () => {
  const provider = new GrokProviderModels(async () => ({
    status: 0,
    stdout: 'Available models:\n  * entitled-model (default)\n',
  }));
  const models = await provider.getSupportedModels();
  assert.equal(models.DEFAULT, 'entitled-model');
  assert.deepEqual(models.OPTIONS.map((option) => option.value), [
    'entitled-model', 'grok-4.6', 'grok-4.5', 'grok-composer-2.5-fast',
  ]);
  assert.equal(await provider.getCacheFingerprint(), 'grok-cli-catalog-v2');
});
