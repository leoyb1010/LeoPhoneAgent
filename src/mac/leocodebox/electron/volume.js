export function volumeNames(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((name) => String(name || '').trim())
    .filter((name) => name && name !== '.' && name !== '..')
    .sort();
}

export function volumeCount(rows) {
  if (!Array.isArray(rows)) return { count: 0, can: false, names: [] };
  const names = volumeNames(rows);
  return { count: names.length, can: true, names };
}

export function volumeShift(prev, next) {
  const a = Number(prev?.count) || 0;
  const b = Number(next?.count) || 0;
  if (b > a) return 'added';
  if (b < a) return 'removed';
  return null;
}

export function readVolumeDir(readDir, root = '/Volumes') {
  if (typeof readDir !== 'function') return null;
  try {
    return readDir(root);
  } catch {
    return null;
  }
}
