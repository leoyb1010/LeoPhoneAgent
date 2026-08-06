import { describe, expect, it } from 'vitest';
import { nextMarketPreviewName } from '../marketPreviewSelection';

describe('market preview selection', () => {
  it('toggles the half-screen preview target when clicking market cards', () => {
    expect(nextMarketPreviewName(null, 'alpha')).toBe('alpha');
    expect(nextMarketPreviewName('alpha', 'beta')).toBe('beta');
    expect(nextMarketPreviewName('alpha', 'alpha')).toBeNull();
  });
});
