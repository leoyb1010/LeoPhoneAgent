export function displayCount(api) {
  if (typeof api?.getAllDisplays !== 'function') return { count: 0, can: false };
  const rows = api.getAllDisplays() || [];
  return { count: rows.length, can: true };
}

export function displayShift(prev, next) {
  const a = Number(prev?.count) || 0;
  const b = Number(next?.count) || 0;
  if (b > a) return 'added';
  if (b < a) return 'removed';
  return null;
}
