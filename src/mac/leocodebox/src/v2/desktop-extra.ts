type DesktopExtraTools = {
  openExtraWindow?: () => Promise<{ ok?: boolean }>;
};

function desktopTools(): DesktopExtraTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopExtraTools(): DesktopExtraTools | undefined {
  return desktopTools();
}

export async function openDesktopExtraWindow(): Promise<void> {
  const run = desktopTools()?.openExtraWindow;
  if (!run) throw new Error('这台电脑现在再开不了窗口');
  await run();
}
