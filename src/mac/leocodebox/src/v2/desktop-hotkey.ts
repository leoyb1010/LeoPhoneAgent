type DesktopHotkeyTools = {
  getGlobalHotkey?: () => Promise<{ on?: boolean }>;
  setGlobalHotkey?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopHotkeyTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopHotkeyTools(): DesktopHotkeyTools | undefined {
  return desktopTools();
}

export async function readGlobalHotkey(): Promise<boolean> {
  const get = desktopTools()?.getGlobalHotkey;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeGlobalHotkey(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setGlobalHotkey;
  if (!set) throw new Error('这台电脑现在设不了快捷键唤出');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
