import { shouldKeepAwake } from './session-awake';

export function canRelaunch(desktop?: { relaunch?: unknown } | null): boolean {
  return Boolean(desktop?.relaunch);
}

export function relaunchBusy(rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null } }>): boolean {
  return shouldKeepAwake(rows);
}

export function relaunchLabel(): string {
  return '重新打开';
}

export function relaunchToast(): string {
  return '正在重新打开';
}

export function relaunchBusyToast(): string {
  return '还有会话在跑，先停掉再重新打开';
}
