export function canUseDockMenu(desktop?: { onDockNew?: unknown } | null): boolean {
  return Boolean(desktop?.onDockNew);
}

export function dockNewToast(): string {
  return '已从程序坞开新会话';
}
