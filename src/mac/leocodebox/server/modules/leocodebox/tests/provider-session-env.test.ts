import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEffectiveSessionEnv } from '../provider-session-env.service.js';

test('active Claude provider replaces inherited switcher environment', () => {
  const env = buildEffectiveSessionEnv({
    KEEP: 'yes',
    ANTHROPIC_BASE_URL: 'https://old.example',
    ANTHROPIC_AUTH_TOKEN: 'old',
    ANTHROPIC_API_KEY: 'old',
    ANTHROPIC_MODEL: 'old-model',
  }, 'claude', {
    baseUrl: 'https://new.example',
    apiKey: 'new-key',
    model: 'new-model',
    modelMapping: { sonnet: 'new-sonnet' },
  });

  assert.equal(env.KEEP, 'yes');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://new.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'new-key');
  assert.equal(env.ANTHROPIC_API_KEY, 'new-key');
  assert.equal(env.ANTHROPIC_MODEL, 'new-model');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'new-sonnet');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'new-model');
});

test('empty active provider fields clear inherited authoritative values', () => {
  const env = buildEffectiveSessionEnv({
    KEEP: 'yes',
    ANTHROPIC_BASE_URL: 'https://old.example',
    ANTHROPIC_AUTH_TOKEN: 'old',
    ANTHROPIC_API_KEY: 'old',
    ANTHROPIC_MODEL: 'old-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku',
  }, 'claude', {});

  assert.equal(env.KEEP, 'yes');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
});

test('empty active Codex provider clears inherited API key', () => {
  const env = buildEffectiveSessionEnv({ OPENAI_API_KEY: 'old', KEEP: 'yes' }, 'codex', {});
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.KEEP, 'yes');
});
