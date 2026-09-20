type DesktopSpacesTools = {
  getVisibleOnAllWorkspaces?: () => Promise<{ on?: boolean }>;
  setVisibleOnAllWorkspaces?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopSpacesTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopSpacesTools(): DesktopSpacesTools | undefined {
  return desktopTools();
}

export async function readAllSpaces(): Promise<boolean> {
  const get = desktopTools()?.getVisibleOnAllWorkspaces;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeAllSpaces(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setVisibleOnAllWorkspaces;
  if (!set) throw new Error('这台电脑现在不能跟着每个桌面');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
