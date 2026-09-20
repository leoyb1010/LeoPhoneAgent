export function canShowSessionDiff(machine?: string | null, file?: string | null): boolean {
  return machine === 'local' && Boolean(file?.trim());
}

export function sessionDiffHint(kind: 'modified' | 'added' | 'clean' | 'binary' | string): string {
  if (kind === 'added') return '新建';
  if (kind === 'binary') return '二进制';
  if (kind === 'clean') return '没有改动';
  return '改动';
}
