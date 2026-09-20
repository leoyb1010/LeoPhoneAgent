export function canMoveSessionFile(machine?: string | null, file?: string | null): boolean {
  return machine === 'local' && Boolean(file?.trim());
}

export function sanitizeMoveFolder(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/');
}

export function moveDestRel(file: string, destFolder = ''): string {
  const rel = file.replace(/\\/g, '/').replace(/\u0000/g, '').trim();
  const base = rel.split('/').filter(Boolean).pop() || 'leo-文件';
  const folder = sanitizeMoveFolder(destFolder);
  return folder ? `${folder}/${base}` : base;
}

export function moveSessionToast(file: string): string {
  const short = file.replace(/\\/g, '/').trim() || '这儿';
  return `已挪到 ${short}`;
}
