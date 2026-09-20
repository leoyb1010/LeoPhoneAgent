type DesktopCrashTools = {
  lastAbrupt?: () => Promise<{ abrupt?: boolean }>;
};

function desktopTools(): DesktopCrashTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function readLastAbrupt(): Promise<boolean> {
  const get = desktopTools()?.lastAbrupt;
  if (!get) return false;
  const row = await get();
  return row?.abrupt === true;
}
