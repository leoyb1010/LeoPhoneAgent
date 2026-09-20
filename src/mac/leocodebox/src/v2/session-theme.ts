export function followSystemLabel(mode?: string | null): string {
  return mode === 'system' ? '现在跟着系统' : '跟随系统';
}

export function followSystemToast(mode?: string | null): string {
  return mode === 'system' ? '已经在跟随系统' : '已跟随系统外观';
}
