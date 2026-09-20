type ThermalRow = { state?: string; hot?: boolean; can?: boolean };

type DesktopThermalTools = {
  getThermal?: () => Promise<ThermalRow>;
  onThermalChanged?: (callback: (row: ThermalRow) => void) => () => void;
};

function desktopTools(): DesktopThermalTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function readThermal(): Promise<ThermalRow> {
  const get = desktopTools()?.getThermal;
  if (!get) return { state: 'unknown', hot: false, can: false };
  const row = await get();
  return {
    state: String(row?.state || 'unknown'),
    hot: Boolean(row?.hot),
    can: Boolean(row?.can),
  };
}

export function onThermalChanged(callback: (row: ThermalRow) => void): () => void {
  const listen = desktopTools()?.onThermalChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback({
    state: String(row?.state || 'unknown'),
    hot: Boolean(row?.hot),
  }));
}
