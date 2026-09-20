type DesktopAppsTools = {
  getAppFolder?: () => Promise<{ in?: boolean; can?: boolean }>;
  moveToApplications?: () => Promise<{ moved?: boolean; already?: boolean }>;
};

function desktopTools(): DesktopAppsTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopAppsTools(): DesktopAppsTools | undefined {
  return desktopTools();
}

export async function readAppFolder(): Promise<boolean> {
  const get = desktopTools()?.getAppFolder;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.in);
}

export async function moveDesktopToApplications(): Promise<{ moved?: boolean; already?: boolean }> {
  const run = desktopTools()?.moveToApplications;
  if (!run) throw new Error('这台电脑现在挪不进程序文件夹');
  return run();
}
