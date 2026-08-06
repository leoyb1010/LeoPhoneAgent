/**
 * videoProtocolRange.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the Range header parser used by the xdt-video:// protocol handler.
 *
 * Why this test exists: the first impl advertised `Accept-Ranges: bytes`
 * while always serving 200 full responses (no Range parsing at all).
 * Chromium <video> issues `Range: bytes=0-` on the first fetch and treats
 * the resource as broken when the server claims to support ranges but then
 * ignores them — the symptom was every generated video showing up as
 * "视频不可用" in the chat bubble even though the file was on disk and
 * playable in any external player. Don't regress it.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

const { parseRangeHeader } = await import('../videoProtocol');

describe('parseRangeHeader', () => {
  it('returns null when header is absent', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });

  it('parses bytes=0- (chromium <video> initial fetch) → full file', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('parses an explicit closed range', () => {
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({
      start: 100,
      end: 199,
    });
  });

  it('parses a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-256', 1000)).toEqual({
      start: 744,
      end: 999,
    });
  });

  it('rejects out-of-range end', () => {
    expect(parseRangeHeader('bytes=0-9999', 1000)).toBeNull();
  });

  it('rejects start > end', () => {
    expect(parseRangeHeader('bytes=500-100', 1000)).toBeNull();
  });

  it('rejects malformed header', () => {
    expect(parseRangeHeader('blocks=0-100', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
  });

  it('handles whitespace around the value', () => {
    expect(parseRangeHeader('  bytes=0-9  ', 1000)).toEqual({
      start: 0,
      end: 9,
    });
  });
});
