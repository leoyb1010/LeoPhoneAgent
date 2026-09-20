export function canOpenExtraWindow(desktop?: { openExtraWindow?: unknown } | null): boolean {
  return Boolean(desktop?.openExtraWindow);
}

export function extraWindowLabel(): string {
  return '再开一个窗口';
}

export function extraWindowToast(): string {
  return '已再开一个窗口';
}
