/**
 * Alpha-visible image bounds shared by the local-theme loader and tests.
 *
 * Electron NativeImage exposes decoded pixels as 4-byte bitmap pixels. RGB
 * channel order is platform-specific, but alpha is consistently byte 3, so
 * transparent-margin detection can stay independent of BGRA/RGBA ordering.
 */

export interface ImageVisibleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export function findVisibleAlphaBounds(
  bitmap: Uint8Array,
  width: number,
  height: number,
  alphaThreshold = 8,
): ImageVisibleBounds | undefined {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    bitmap.byteLength !== width * height * 4
  ) {
    return undefined;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (bitmap[rowOffset + x * 4 + 3] <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return undefined;
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
    return undefined;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    sourceWidth: width,
    sourceHeight: height,
  };
}
