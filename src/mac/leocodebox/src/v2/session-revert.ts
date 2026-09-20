export function canRevertSessionFile(machine?: string | null, file?: string | null): boolean {
  return machine === 'local' && Boolean(file?.trim());
}

export function revertSessionFileToast(action: 'restored' | 'removed'): string {
  return action === 'removed' ? '已删掉这次新建的文件' : '已还原到改之前';
}
