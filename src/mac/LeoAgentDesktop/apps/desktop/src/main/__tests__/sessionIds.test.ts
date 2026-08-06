import { describe, expect, it } from 'vitest';

import { createBusinessSessionId, resolveBusinessSessionId } from '../sessionIds';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('desktop business session ids', () => {
  it('creates UUID v4 ids for new desktop-owned sessions', () => {
    const id = createBusinessSessionId();

    expect(id).toMatch(UUID_V4_RE);
  });

  it('preserves explicit legacy/custom ids for compatibility', () => {
    expect(resolveBusinessSessionId('legacy-cuid2-session')).toBe('legacy-cuid2-session');
    expect(resolveBusinessSessionId('feishu_bot_user')).toBe('feishu_bot_user');
  });

  it('falls back to UUID v4 when no explicit id is provided', () => {
    expect(resolveBusinessSessionId(undefined)).toMatch(UUID_V4_RE);
    expect(resolveBusinessSessionId('')).toMatch(UUID_V4_RE);
  });
});
