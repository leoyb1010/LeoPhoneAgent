export const PACK_FILE_MAX = 40;

export function canPackSessionChanges(machine?: string | null): boolean {
  return machine === 'local';
}

export function packFileName(title: string): string {
  const safe = title.trim().replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '').replace(/-+$/g, '').slice(0, 40);
  return safe ? `leo-改动-${safe}.zip` : 'leo-改动.zip';
}

export function packSessionToast(name: string, count: number): string {
  const short = name.trim() || 'leo-改动.zip';
  return count > 0 ? `已打成一份 · ${short} · ${count} 个文件` : `已打成一份 · ${short}`;
}
