type DesktopLogsTools = {
  openLogs?: () => Promise<{ path?: string }>;
};

function desktopTools(): DesktopLogsTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopLogsTools(): DesktopLogsTools | undefined {
  return desktopTools();
}

export async function openDesktopLogs(): Promise<string> {
  const open = desktopTools()?.openLogs;
  if (!open) throw new Error('这台电脑现在打不开日志');
  const row = await open();
  return String(row?.path ?? '');
}
