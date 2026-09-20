type DesktopRelaunchTools = {
  relaunch?: () => Promise<{ ok?: boolean }>;
};

function desktopTools(): DesktopRelaunchTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopRelaunchTools(): DesktopRelaunchTools | undefined {
  return desktopTools();
}

export async function relaunchDesktop(): Promise<void> {
  const run = desktopTools()?.relaunch;
  if (!run) throw new Error('这台电脑现在重新打不开');
  await run();
}
