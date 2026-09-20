export const SEED_TEXT_MAX = 200_000;

export function canSeedSessionFile(machine?: string | null): boolean {
  return machine === 'local';
}

export function sanitizeSeedRel(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/') || 'leo-新建.txt';
}

export function clipSeedText(text: string, limit = SEED_TEXT_MAX): string {
  const clean = text.replace(/\u0000/g, '');
  if (clean.length <= limit) return clean;
  throw new Error('这段字太长，落不成文件');
}

export function seedSessionToast(name: string): string {
  const short = name.trim() || 'leo-新建.txt';
  return `已建 ${short}`;
}
