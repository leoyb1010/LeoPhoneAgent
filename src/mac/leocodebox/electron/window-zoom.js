export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const WINDOW_ZOOM_FILE = 'window-zoom.json';

export function sanitizeZoomFactor(raw) {
  const n = typeof raw === 'object' && raw !== null ? Number(raw.factor) : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_ZOOM || n > MAX_ZOOM) return null;
  return Math.round(n * 100) / 100;
}

export function snapshotZoomFactor(webContents) {
  if (!webContents || typeof webContents.getZoomFactor !== 'function') return null;
  try {
    return sanitizeZoomFactor(webContents.getZoomFactor());
  } catch {
    return null;
  }
}
