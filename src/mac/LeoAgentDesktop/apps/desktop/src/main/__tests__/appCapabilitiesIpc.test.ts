import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'local' as 'local' | 'cloud',
  boundaryPending: false,
}));

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: state.mode, dataOwnerId: null, generation: 0 }),
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));

import { requireAppCapability } from '../appCapabilities.js';

describe('requireAppCapability IPC errors', () => {
  beforeEach(() => {
    state.mode = 'local';
    state.boundaryPending = false;
  });

  it('encodes unavailable account capabilities as permission errors', () => {
    expect(() => requireAppCapability('canUseSkillHubCloud')).toThrow(/\[PERMISSION_DENIED\]/);
  });

  it('encodes owner-boundary failures as retryable precondition errors', () => {
    state.mode = 'cloud';
    state.boundaryPending = true;
    expect(() => requireAppCapability('canUseDeviceLink')).toThrow(/\[PRECONDITION_FAILED\]/);
  });
});
