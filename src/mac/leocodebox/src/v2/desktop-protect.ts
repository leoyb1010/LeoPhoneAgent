type DesktopProtectTools = {
  getContentProtection?: () => Promise<{ on?: boolean }>;
  setContentProtection?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopProtectTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopProtectTools(): DesktopProtectTools | undefined {
  return desktopTools();
}

export async function readContentProtection(): Promise<boolean> {
  const get = desktopTools()?.getContentProtection;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeContentProtection(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setContentProtection;
  if (!set) throw new Error('这台电脑现在藏不住窗口');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
