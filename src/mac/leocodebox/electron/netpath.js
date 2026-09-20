function isPublicV4(row) {
  if (!row || row.internal) return false;
  const family = row.family;
  if (family !== 'IPv4' && family !== 4) return false;
  const addr = String(row.address || '').trim();
  if (!addr || addr.startsWith('169.254.')) return false;
  return true;
}

export function netpathState(table) {
  if (!table || typeof table !== 'object') return { key: '', can: false, addrs: [] };
  const addrs = [];
  for (const rows of Object.values(table)) {
    for (const row of rows || []) {
      if (!isPublicV4(row)) continue;
      addrs.push(String(row.address).trim());
    }
  }
  addrs.sort();
  return { key: addrs.join(','), can: true, addrs };
}

export function netpathShift(prev, next) {
  if (!prev?.can || !next?.can) return null;
  if (!prev.key || !next.key) return null;
  if (prev.key === next.key) return null;
  return 'changed';
}
