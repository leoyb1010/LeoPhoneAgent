import { describe, expect, it } from 'vitest';

import { decodeAccessTokenOrgSlug } from '../authTokenClaims';

function fakeJwt(payload: object): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.fake-signature`;
}

describe('decodeAccessTokenOrgSlug', () => {
  it('decodes the orgSlug claim from an org-context token', () => {
    expect(decodeAccessTokenOrgSlug(fakeJwt({ ctx: 'org', orgSlug: 'xd' }))).toBe('xd');
  });

  it('returns null for personal-context tokens without the claim', () => {
    expect(decodeAccessTokenOrgSlug(fakeJwt({ ctx: 'personal', email: 'a@b.c' }))).toBeNull();
  });

  it('returns null for empty or non-string claim values', () => {
    expect(decodeAccessTokenOrgSlug(fakeJwt({ orgSlug: '' }))).toBeNull();
    expect(decodeAccessTokenOrgSlug(fakeJwt({ orgSlug: 42 }))).toBeNull();
  });

  it('returns null for missing or malformed tokens without throwing', () => {
    expect(decodeAccessTokenOrgSlug(null)).toBeNull();
    expect(decodeAccessTokenOrgSlug('')).toBeNull();
    expect(decodeAccessTokenOrgSlug('not-a-jwt')).toBeNull();
    expect(decodeAccessTokenOrgSlug('a.@@invalid-base64@@.c')).toBeNull();
  });
});
