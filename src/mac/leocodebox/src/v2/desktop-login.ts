type DesktopLoginTools = {
  getOpenAtLogin?: () => Promise<{ on?: boolean }>;
  setOpenAtLogin?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopLoginTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopLoginTools(): DesktopLoginTools | undefined {
  return desktopTools();
}

export async function readOpenAtLogin(): Promise<boolean> {
  const get = desktopTools()?.getOpenAtLogin;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeOpenAtLogin(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setOpenAtLogin;
  if (!set) throw new Error('这台电脑现在设不了开机就开');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
