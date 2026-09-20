export function canSetOpenAtLogin(desktop?: { setOpenAtLogin?: unknown; getOpenAtLogin?: unknown } | null): boolean {
  return Boolean(desktop?.setOpenAtLogin || desktop?.getOpenAtLogin);
}

export function openAtLoginToast(on: boolean): string {
  return on ? '已设成开机就开' : '已关掉开机自开';
}

export function openAtLoginLabel(on: boolean): string {
  return on ? '开机不要开' : '开机就开';
}
