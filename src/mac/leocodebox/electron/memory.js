export const LOW_FREE_KB = 512 * 1024;
export const LOW_RATIO = 0.08;

export function memoryState(info) {
  const total = Number(info?.total) || 0;
  const free = Number(info?.free) || 0;
  if (!total) return { free: 0, total: 0, can: false, low: false };
  return {
    free,
    total,
    can: true,
    low: free < LOW_FREE_KB || free / total < LOW_RATIO,
  };
}
