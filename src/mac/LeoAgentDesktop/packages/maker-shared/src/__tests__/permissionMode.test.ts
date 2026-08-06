import { describe, expect, it } from 'vitest';

import {
  permissionModeOrAsk,
  requiresFullAccessConfirmation,
} from '../permissionMode.js';

describe('permissionModeOrAsk', () => {
  it.each([
    'ask',
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'bypassPermissions',
  ] as const)('preserves the known mode %s', (mode) => {
    expect(permissionModeOrAsk(mode)).toBe(mode);
  });

  it.each([undefined, null, '', 'future-mode', 1, {}])(
    'fails closed for %j',
    (value) => {
      expect(permissionModeOrAsk(value)).toBe('ask');
    },
  );
});

describe('requiresFullAccessConfirmation', () => {
  it.each(['ask', 'default', 'acceptEdits', 'plan', 'auto', undefined, 'future-mode'])(
    'requires confirmation when entering Full access from %j',
    (currentMode) => {
      expect(requiresFullAccessConfirmation(currentMode, 'bypassPermissions')).toBe(true);
    },
  );

  it('does not ask again while already in Full access', () => {
    expect(requiresFullAccessConfirmation('bypassPermissions', 'bypassPermissions')).toBe(false);
  });

  it('does not ask when switching to a safer mode', () => {
    expect(requiresFullAccessConfirmation('bypassPermissions', 'ask')).toBe(false);
  });
});
