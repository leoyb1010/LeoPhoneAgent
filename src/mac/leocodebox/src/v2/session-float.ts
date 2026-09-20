export function canSetAlwaysOnTop(desktop?: { setAlwaysOnTop?: unknown; getAlwaysOnTop?: unknown } | null): boolean {
  return Boolean(desktop?.setAlwaysOnTop || desktop?.getAlwaysOnTop);
}

export function alwaysOnTopToast(on: boolean): string {
  return on ? '已钉在最上面' : '已取消置顶';
}

export function alwaysOnTopLabel(on: boolean): string {
  return on ? '不要钉在最上面' : '钉在最上面';
}
