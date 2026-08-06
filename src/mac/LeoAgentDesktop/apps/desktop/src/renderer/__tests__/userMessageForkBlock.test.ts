import { describe, expect, it } from 'vitest';

import { shouldBlockUserFork } from '../components/chat/UserMessage';

describe('shouldBlockUserFork', () => {
  it('blocks same-turn steer user messages only while the session is running', () => {
    expect(shouldBlockUserFork(true, 'steer')).toBe(true);
    expect(shouldBlockUserFork(false, 'steer')).toBe(false);
    expect(shouldBlockUserFork(true, 'turn')).toBe(false);
    expect(shouldBlockUserFork(true, undefined)).toBe(false);
  });
});
