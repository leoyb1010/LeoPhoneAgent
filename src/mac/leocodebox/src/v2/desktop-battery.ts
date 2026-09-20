type DesktopBatteryTools = {
  getBattery?: () => Promise<{ on?: boolean; can?: boolean }>;
  onBatteryChanged?: (callback: (row: { on?: boolean }) => void) => () => void;
};

function desktopTools(): DesktopBatteryTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function readBattery(): Promise<boolean> {
  const get = desktopTools()?.getBattery;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.on);
}

export function onBatteryChanged(callback: (on: boolean) => void): () => void {
  const listen = desktopTools()?.onBatteryChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback(Boolean(row?.on)));
}
