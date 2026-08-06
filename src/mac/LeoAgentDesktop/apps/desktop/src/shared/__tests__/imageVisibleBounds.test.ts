import { describe, expect, it } from 'vitest';

import { findVisibleAlphaBounds } from '../imageVisibleBounds';

function bitmap(width: number, height: number, visible: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (const [x, y] of visible) out[(y * width + x) * 4 + 3] = 255;
  return out;
}

describe('findVisibleAlphaBounds', () => {
  it('returns the tight alpha bounds while preserving source dimensions', () => {
    const out = findVisibleAlphaBounds(
      bitmap(5, 4, [
        [1, 1],
        [3, 2],
      ]),
      5,
      4,
    );
    expect(out).toEqual({
      x: 1,
      y: 1,
      width: 3,
      height: 2,
      sourceWidth: 5,
      sourceHeight: 4,
    });
  });

  it('omits metadata when the visible content already fills the canvas', () => {
    const points: Array<[number, number]> = [];
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 3; x += 1) points.push([x, y]);
    }
    expect(findVisibleAlphaBounds(bitmap(3, 2, points), 3, 2)).toBeUndefined();
  });

  it('rejects empty and malformed bitmaps', () => {
    expect(findVisibleAlphaBounds(new Uint8Array(16), 2, 2)).toBeUndefined();
    expect(findVisibleAlphaBounds(new Uint8Array(3), 2, 2)).toBeUndefined();
  });
});
