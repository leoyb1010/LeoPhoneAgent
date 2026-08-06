import { describe, expect, it } from 'vitest';
import {
  matchesOAuthCallbackUrl,
  parseOAuthCallbackUrl,
} from '@/auth/oauthCallback';

// 回调 URL 的 host 部分对解析无语义,任意 https 基址即可
const CALLBACK_BASE = 'https://auth.example.invalid';

describe('parseOAuthCallbackUrl', () => {
  it('extracts code and state from callback URL', () => {
    expect(parseOAuthCallbackUrl(`${CALLBACK_BASE}/api/auth/callback?code=c1&state=s1`)).toEqual({
      code: 'c1',
      state: 's1',
    });
  });

  it('extracts code and state from app deep link', () => {
    expect(parseOAuthCallbackUrl('cindycn://auth?code=c1&state=cn.s1')).toEqual(
      {
        code: 'c1',
        state: 'cn.s1',
      },
    );
  });

  it('rejects OAuth error callbacks', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${CALLBACK_BASE}/api/auth/callback?error=access_denied&state=s1`,
      ),
    ).toThrow('access_denied');
  });

  it('requires both code and state', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${CALLBACK_BASE}/api/auth/callback?state=s1`,
      ),
    ).toThrow('INVALID_AUTH_CODE');
    expect(() =>
      parseOAuthCallbackUrl(
        `${CALLBACK_BASE}/api/auth/callback?code=c1`,
      ),
    ).toThrow('STATE_MISMATCH');
  });
});

describe('matchesOAuthCallbackUrl', () => {
  it('accepts the configured callback with variable query parameters', () => {
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth/?code=abc&state=xyz',
        'cindycn://auth',
      ),
    ).toBe(true);
  });

  it('rejects lookalike hosts and paths', () => {
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth.evil/?code=abc',
        'cindycn://auth',
      ),
    ).toBe(false);
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth/extra?code=abc',
        'cindycn://auth',
      ),
    ).toBe(false);
    expect(
      matchesOAuthCallbackUrl('cindy://auth?code=abc', 'cindycn://auth'),
    ).toBe(false);
  });
});
