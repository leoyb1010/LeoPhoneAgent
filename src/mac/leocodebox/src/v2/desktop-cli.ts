type DesktopCliTools = {
  getCliInstall?: () => Promise<{ on?: boolean }>;
  setCliInstall?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopCliTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopCliTools(): DesktopCliTools | undefined {
  return desktopTools();
}

export async function readCliInstall(): Promise<boolean> {
  const get = desktopTools()?.getCliInstall;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeCliInstall(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setCliInstall;
  if (!set) throw new Error('这台电脑现在装不进终端');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
