import { describe, expect, it } from 'vitest';

import '../../../themes/colors';
import { colorRegistry } from '../../../themes/color-registry';

describe('IM bot connected status visual contract', () => {
  it('uses the global done green for connected indicators in both themes', () => {
    expect(colorRegistry.resolveDefault('settings-badge-connected', 'light')).toBe(
      'var(--card-status-done)',
    );
    expect(colorRegistry.resolveDefault('settings-badge-connected', 'dark')).toBe(
      'var(--card-status-done)',
    );
  });

  it('keeps connected badge text neutral', () => {
    expect(colorRegistry.resolveDefault('settings-badge-connected-text', 'light')).toBe(
      'var(--text-primary)',
    );
    expect(colorRegistry.resolveDefault('settings-badge-connected-text', 'dark')).toBe(
      'var(--text-primary)',
    );
  });
});
