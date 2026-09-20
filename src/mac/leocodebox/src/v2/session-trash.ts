export function canTrashSessionFile(machine?: string | null, file?: string | null): boolean {
  return machine === 'local' && Boolean(file?.trim());
}

export function trashSessionToast(file: string): string {
  const short = file.replace(/\\/g, '/').split('/').filter(Boolean).pop() || file.trim();
  return short ? `已扔掉 ${short}` : '已扔掉这份文件';
}
