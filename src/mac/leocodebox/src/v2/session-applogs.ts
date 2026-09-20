export function canOpenLogs(desktop?: { openLogs?: unknown } | null): boolean {
  return Boolean(desktop?.openLogs);
}

export function openLogsLabel(): string {
  return '打开日志';
}

export function openLogsToast(): string {
  return '已打开日志';
}
