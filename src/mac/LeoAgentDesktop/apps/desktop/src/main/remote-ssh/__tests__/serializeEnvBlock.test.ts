/**
 * Tests for serializeEnvBlock — stdin protocol serializer used by the
 * remote-agent one-shot IPC handler.
 *
 * Why these tests matter:
 *   The function is the gatekeeper between renderer-supplied env dicts
 *   (API keys, base URLs) and the stdin bytes shipped to a remote bash
 *   wrapper. A newline silently passing through would split a single
 *   value across the env/prompt boundary on the remote — leaking part
 *   of an API key into the prompt body. The function throws hard rather
 *   than emit ambiguous output; these tests pin that contract.
 */

import { describe, expect, it } from 'vitest';

import { serializeEnvBlock } from '../env-block';

describe('serializeEnvBlock', () => {
  it('joins valid env entries as KEY=value lines', () => {
    const out = serializeEnvBlock({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    // Order follows insertion order of Object.entries — pin it so the
    // remote-side parser can rely on a stable ordering across builds.
    expect(out).toBe('ANTHROPIC_API_KEY=sk-ant-test\nANTHROPIC_BASE_URL=https://api.example.com');
  });

  it('returns empty string for empty env', () => {
    expect(serializeEnvBlock({})).toBe('');
  });

  it('preserves whitespace and special chars inside value (other than newlines)', () => {
    const out = serializeEnvBlock({
      FOO: 'a b c=d e\tf',
    });
    expect(out).toBe('FOO=a b c=d e\tf');
  });

  it('throws when a value contains a newline', () => {
    expect(() =>
      serializeEnvBlock({ LEAKY: 'first\nsecond' }),
    ).toThrow(/LEAKY/);
  });

  it('throws when a value contains a carriage return', () => {
    expect(() =>
      serializeEnvBlock({ LEAKY: 'first\rsecond' }),
    ).toThrow(/LEAKY/);
  });

  it('throws when the key is not a POSIX-valid identifier (lowercase start)', () => {
    expect(() => serializeEnvBlock({ lower: 'x' })).toThrow(/lower/);
  });

  it('throws when the key starts with a digit', () => {
    expect(() => serializeEnvBlock({ '1FOO': 'x' })).toThrow(/1FOO/);
  });

  it('throws when the key contains a hyphen', () => {
    expect(() => serializeEnvBlock({ 'FOO-BAR': 'x' })).toThrow(/FOO-BAR/);
  });

  it('accepts uppercase letters, digits, and underscore', () => {
    const out = serializeEnvBlock({ FOO_BAR_2: 'ok' });
    expect(out).toBe('FOO_BAR_2=ok');
  });

  it('accepts leading underscore', () => {
    const out = serializeEnvBlock({ _PRIVATE: 'ok' });
    expect(out).toBe('_PRIVATE=ok');
  });
});
