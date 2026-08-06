import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../xdt-helper/_history_cursor.js';

describe('history cursor encoding', () => {
  it('round-trips the stable message rowid tie-breaker', () => {
    const raw = encodeCursor({ createdAt: 1_000, id: 'message-1', rowid: 42 });
    expect(decodeCursor(raw)).toEqual({ createdAt: 1_000, id: 'message-1', rowid: 42 });
  });

  it('keeps legacy cursors without rowid readable', () => {
    const raw = encodeCursor({ createdAt: 1_000, id: 'message-1' });
    expect(decodeCursor(raw)).toEqual({ createdAt: 1_000, id: 'message-1' });
  });

  it('rejects malformed rowid values instead of silently changing pagination order', () => {
    const malformed = Buffer.from(JSON.stringify({ c: 1_000, i: 'message-1', r: 0 }), 'utf8')
      .toString('base64url');
    expect(decodeCursor(malformed)).toBeNull();
  });
});
