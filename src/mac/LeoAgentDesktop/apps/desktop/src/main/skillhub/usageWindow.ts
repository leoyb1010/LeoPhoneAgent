export const RECENT_USAGE_WINDOW_DAYS = 30;

export function recentWindowStartMs(nowMs: number): number {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (RECENT_USAGE_WINDOW_DAYS - 1));
  return start.getTime();
}
