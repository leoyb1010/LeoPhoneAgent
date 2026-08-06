import { describe, expect, it } from 'vitest';

import { uniqueCustomProviderId } from './customProviderId';

describe('uniqueCustomProviderId', () => {
  it('generates a stable non-generic id for a pure Chinese name', () => {
    const first = uniqueCustomProviderId('测试网关', new Set());
    expect(first).toMatch(/^provider-[a-z0-9]+$/);
    expect(first).not.toBe('provider');
    expect(uniqueCustomProviderId('测试网关', new Set())).toBe(first);
  });

  it('keeps IDs unique when names normalize to the same slug', () => {
    const first = uniqueCustomProviderId('测试网关', new Set());
    const second = uniqueCustomProviderId('测试网关', new Set([first]));
    expect(second).toBe(`${first}-2`);
  });
});
