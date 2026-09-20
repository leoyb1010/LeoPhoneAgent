import { DEFAULT_WINDOW, MIN_WINDOW } from './window-bounds.js';

export const EXTRA_WINDOW_OFFSET = 36;

export function extraWindowBounds(mainBounds) {
  const src = mainBounds && Number.isFinite(mainBounds.width)
    ? mainBounds
    : { x: 80, y: 80, ...DEFAULT_WINDOW };
  return {
    x: (Number(src.x) || 0) + EXTRA_WINDOW_OFFSET,
    y: (Number(src.y) || 0) + EXTRA_WINDOW_OFFSET,
    width: Math.max(MIN_WINDOW.width, Number(src.width) || DEFAULT_WINDOW.width),
    height: Math.max(MIN_WINDOW.height, Number(src.height) || DEFAULT_WINDOW.height),
  };
}
