export function canLockApp(desktop?: { setAppLock?: unknown; getAppLock?: unknown } | null): boolean {
  return Boolean(desktop?.setAppLock || desktop?.getAppLock);
}

export function lockToast(on: boolean): string {
  return on ? '已锁住' : '已解锁';
}

export function lockLabel(on: boolean): string {
  return on ? '解锁' : '锁住软件';
}
