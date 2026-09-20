import { relaunchBusy } from './session-relaunch';

export function canMoveToApplications(desktop?: { getAppFolder?: unknown; moveToApplications?: unknown } | null): boolean {
  return Boolean(desktop?.getAppFolder || desktop?.moveToApplications);
}

export function moveToApplicationsBusy(rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null } }>): boolean {
  return relaunchBusy(rows);
}

export function moveToApplicationsLabel(already: boolean): string {
  return already ? '已经在程序文件夹' : '挪进程序文件夹';
}

export function moveToApplicationsToast(already: boolean): string {
  return already ? '已经在程序文件夹了' : '正在挪进程序文件夹';
}

export function moveToApplicationsBusyToast(): string {
  return '还有会话在跑，先停掉再挪';
}
