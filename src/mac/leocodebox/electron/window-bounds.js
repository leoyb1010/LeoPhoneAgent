export const DEFAULT_WINDOW = { width: 1440, height: 960 };
export const MIN_WINDOW = { width: 1024, height: 720 };
export const WINDOW_BOUNDS_FILE = 'window-bounds.json';

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function intersects(bounds, display) {
  const left = display.x;
  const top = display.y;
  const right = display.x + display.width;
  const bottom = display.y + display.height;
  const x = bounds.x;
  const y = bounds.y;
  return x < right && x + 80 > left && y < bottom && y + 40 > top;
}

export function displayBoxes(displays) {
  return (displays ?? []).map((row) => {
    const box = row.workArea || row.bounds || row;
    return {
      x: Number(box.x) || 0,
      y: Number(box.y) || 0,
      width: Number(box.width) || 0,
      height: Number(box.height) || 0,
    };
  }).filter((box) => box.width > 0 && box.height > 0);
}

export function sanitizeWindowBounds(raw, displays) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (![x, y, width, height].every(finite)) return null;
  if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) return null;
  if (width > 8000 || height > 5000) return null;
  const boxes = displayBoxes(displays);
  if (!boxes.length) return { x, y, width, height };
  if (!boxes.some((box) => intersects({ x, y }, box))) return null;
  return { x, y, width, height };
}

export function snapshotWindowBounds(win) {
  if (!win || typeof win.getBounds !== 'function') return null;
  const maximized = Boolean(typeof win.isMaximized === 'function' && win.isMaximized());
  const bounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
  const clean = sanitizeWindowBounds(bounds, []);
  if (!clean) return null;
  return { ...clean, maximized };
}
