import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetSidebarCommandsForTests,
  onRequestRightSidebarVisibility,
  requestRightSidebarVisibility,
  shouldAnimateSidebarVisibilityRequest,
} from '../sidebarCommands';

describe('sidebar visibility commands', () => {
  afterEach(() => {
    _resetSidebarCommandsForTests();
  });

  it('defaults command-driven visibility changes to animated unless explicitly disabled', () => {
    expect(shouldAnimateSidebarVisibilityRequest({ sessionId: 's1' })).toBe(true);
    expect(shouldAnimateSidebarVisibilityRequest({ sessionId: 's1', animate: true })).toBe(true);
    expect(shouldAnimateSidebarVisibilityRequest({ sessionId: 's1', animate: false })).toBe(false);
  });

  it('delivers animate:false to the MainLayout subscription layer', () => {
    const listener = vi.fn();
    onRequestRightSidebarVisibility(listener);

    requestRightSidebarVisibility('open', { sessionId: 's1', animate: false });

    expect(listener).toHaveBeenCalledWith('open', { sessionId: 's1', animate: false });
    expect(shouldAnimateSidebarVisibilityRequest(listener.mock.calls[0][1])).toBe(false);
  });
});
