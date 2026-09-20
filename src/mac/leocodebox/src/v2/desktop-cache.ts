type DesktopCacheTools = {
  clearCache?: () => Promise<{ ok?: boolean }>;
};

function desktopTools(): DesktopCacheTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopCacheTools(): DesktopCacheTools | undefined {
  return desktopTools();
}

export async function clearDesktopCache(): Promise<void> {
  const run = desktopTools()?.clearCache;
  if (!run) throw new Error('这台电脑现在清不掉缓存');
  await run();
}
