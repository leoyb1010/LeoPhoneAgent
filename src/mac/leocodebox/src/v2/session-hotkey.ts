export function canSetGlobalHotkey(desktop?: { setGlobalHotkey?: unknown; getGlobalHotkey?: unknown } | null): boolean {
  return Boolean(desktop?.setGlobalHotkey || desktop?.getGlobalHotkey);
}

export function globalHotkeyToast(on: boolean): string {
  return on ? '已打开快捷键唤出' : '已关掉快捷键唤出';
}

export function globalHotkeyLabel(on: boolean): string {
  return on ? '不要快捷键唤出' : '快捷键唤出';
}
