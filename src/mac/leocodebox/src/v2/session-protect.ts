export function canSetContentProtection(desktop?: { setContentProtection?: unknown; getContentProtection?: unknown } | null): boolean {
  return Boolean(desktop?.setContentProtection || desktop?.getContentProtection);
}

export function contentProtectionToast(on: boolean): string {
  return on ? '分享时已藏住窗口' : '已取消藏住窗口';
}

export function contentProtectionLabel(on: boolean): string {
  return on ? '不要藏住窗口' : '分享时藏住窗口';
}
