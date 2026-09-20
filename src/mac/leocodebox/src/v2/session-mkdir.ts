export function canMkdirSessionFolder(machine?: string | null): boolean {
  return machine === 'local';
}

export function sanitizeFolderRel(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/') || 'leo-新建';
}

export function mkdirSessionToast(name: string): string {
  const short = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() || name.trim();
  return short ? `已建文件夹 ${short}` : '已建文件夹';
}
