type DesktopFloatTools = {
  getAlwaysOnTop?: () => Promise<{ on?: boolean }>;
  setAlwaysOnTop?: (on: boolean) => Promise<{ on?: boolean }>;
};

function desktopTools(): DesktopFloatTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopFloatTools(): DesktopFloatTools | undefined {
  return desktopTools();
}

export async function readAlwaysOnTop(): Promise<boolean> {
  const get = desktopTools()?.getAlwaysOnTop;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeAlwaysOnTop(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setAlwaysOnTop;
  if (!set) throw new Error('这台电脑现在钉不了窗口');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}
