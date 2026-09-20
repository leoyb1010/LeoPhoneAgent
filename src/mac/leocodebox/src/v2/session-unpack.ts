export const UNPACK_FILE_MAX = 80;

export function canUnpackSessionZip(machine?: string | null): boolean {
  return machine === 'local';
}

export function looksLikeZip(name?: string | null): boolean {
  return Boolean(name?.trim().toLowerCase().endsWith('.zip'));
}

export function unpackZipName(raw?: string | null): string {
  const text = (raw ?? '').trim().replace(/\\/g, '/');
  if (!looksLikeZip(text)) return '';
  const base = text.split('/').filter(Boolean).pop() ?? '';
  return looksLikeZip(base) ? base : '';
}

export function unpackSessionToast(name: string, count: number): string {
  const short = name.trim() || 'zip';
  return count > 0 ? `已解开 ${short} · ${count} 个文件` : `已解开 ${short}`;
}
