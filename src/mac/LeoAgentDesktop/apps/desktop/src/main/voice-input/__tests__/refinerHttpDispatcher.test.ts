import { describe, expect, it } from 'vitest';

import { resolveRefinerHttpDispatcherOptions } from '../refinerHttpDispatcher.js';

describe('resolveRefinerHttpDispatcherOptions', () => {
  it('applies defaults when env is empty', () => {
    expect(resolveRefinerHttpDispatcherOptions({})).toEqual({
      keepAliveMs: 60_000,
      connectAttemptTimeoutMs: 2_500,
    });
  });

  it('reads overrides from env', () => {
    expect(resolveRefinerHttpDispatcherOptions({
      XDT_VOICE_INPUT_REFINER_KEEPALIVE_MS: '120000',
      XDT_VOICE_INPUT_REFINER_CONNECT_ATTEMPT_TIMEOUT_MS: '1500',
    })).toEqual({
      keepAliveMs: 120_000,
      connectAttemptTimeoutMs: 1_500,
    });
  });

  it('falls back on invalid or non-positive values', () => {
    expect(resolveRefinerHttpDispatcherOptions({
      XDT_VOICE_INPUT_REFINER_KEEPALIVE_MS: 'not-a-number',
      XDT_VOICE_INPUT_REFINER_CONNECT_ATTEMPT_TIMEOUT_MS: '0',
    })).toEqual({
      keepAliveMs: 60_000,
      connectAttemptTimeoutMs: 2_500,
    });
  });
});
