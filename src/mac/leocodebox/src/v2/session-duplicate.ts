export function canDuplicateSessionFile(machine?: string | null, file?: string | null): boolean {
  return machine === 'local' && Boolean(file?.trim());
}

export function duplicateCopyName(file: string): string {
  const rel = file.replace(/\\/g, '/').replace(/\u0000/g, '').trim();
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const clean = (stem || 'leo-文件').replace(/-副本(?:-\d+)?$/, '');
  return `${dir}${clean}-副本${ext}`;
}

export function duplicateSessionToast(file: string): string {
  const short = file.replace(/\\/g, '/').split('/').filter(Boolean).pop() || file.trim();
  return short ? `已复制 ${short}` : '已复制一份';
}
