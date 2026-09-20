export const APPLY_PATCH_MAX = 80_000;

export function canApplySessionPatch(machine?: string | null): boolean {
  return machine === 'local';
}

export function clipApplyPatch(text: string, limit = APPLY_PATCH_MAX): string {
  const clean = text.replace(/\u0000/g, '');
  if (clean.trim().length <= 0) return '';
  if (clean.length <= limit) return clean;
  throw new Error('这份补丁太长');
}

export function applyPatchToast(files: readonly string[]): string {
  if (!files.length) return '补丁已贴上';
  if (files.length === 1) return `已贴上 ${files[0]}`;
  return `已贴上 ${files.length} 个文件`;
}
