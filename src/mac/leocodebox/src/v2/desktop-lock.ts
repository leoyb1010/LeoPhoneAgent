type DesktopLockTools = {
  getAppLock?: () => Promise<{ on?: boolean }>;
  setAppLock?: (on: boolean) => Promise<{ on?: boolean }>;
  onAppLockChanged?: (callback: (row: { on?: boolean }) => void) => () => void;
};

function desktopTools(): DesktopLockTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopLockTools(): DesktopLockTools | undefined {
  return desktopTools();
}

export async function readAppLock(): Promise<boolean> {
  const get = desktopTools()?.getAppLock;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export async function writeAppLock(on: boolean): Promise<boolean> {
  const set = desktopTools()?.setAppLock;
  if (!set) throw new Error('这台电脑现在锁不住');
  const row = await set(Boolean(on));
  return Boolean(row?.on);
}

export function onAppLockChanged(callback: (on: boolean) => void): () => void {
  const listen = desktopTools()?.onAppLockChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback(Boolean(row?.on)));
}
