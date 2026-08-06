import { describe, expect, it } from 'vitest';

import { canAccessSkillhubMarket } from '../marketAccess';

function user(
  overrides: Partial<{
    membershipKind: 'personal' | 'org';
    orgName: string | null;
    orgSlug: string | null;
  }> = {},
) {
  return {
    membershipKind: 'org' as const,
    orgName: null,
    orgSlug: null,
    ...overrides,
  };
}

describe('canAccessSkillhubMarket', () => {
  it('allows xd org members by orgSlug', () => {
    expect(canAccessSkillhubMarket(user({ orgSlug: 'xd', orgName: '心动' }))).toBe(true);
  });

  it('denies non-xd org slugs regardless of display name', () => {
    expect(canAccessSkillhubMarket(user({ orgSlug: 'disco-corp', orgName: 'xd' }))).toBe(false);
    // slug 只做全等匹配,不做包含匹配
    expect(canAccessSkillhubMarket(user({ orgSlug: 'xd-partner' }))).toBe(false);
  });

  it('falls back to orgName equality only when orgSlug claim is missing', () => {
    expect(canAccessSkillhubMarket(user({ orgSlug: null, orgName: 'xd' }))).toBe(true);
    expect(canAccessSkillhubMarket(user({ orgSlug: null, orgName: ' XD ' }))).toBe(true);
    expect(canAccessSkillhubMarket(user({ orgSlug: null, orgName: 'Disco Corp' }))).toBe(false);
    expect(canAccessSkillhubMarket(user({ orgSlug: null, orgName: null }))).toBe(false);
  });

  it('denies personal accounts even with stale org fields (fail-closed)', () => {
    expect(
      canAccessSkillhubMarket(user({ membershipKind: 'personal', orgSlug: 'xd', orgName: 'xd' })),
    ).toBe(false);
  });

  it('denies missing login state (fail-closed)', () => {
    expect(canAccessSkillhubMarket(null)).toBe(false);
  });
});
