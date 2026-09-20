type LoadRow = { busy?: boolean; can?: boolean };

type DesktopLoadTools = {
  getLoad?: () => Promise<LoadRow>;
  onLoadChanged?: (callback: (row: LoadRow) => void) => () => void;
};

function desktopTools(): DesktopLoadTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function readLoad(): Promise<boolean> {
  const get = desktopTools()?.getLoad;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.busy);
}

export function onLoadChanged(callback: (busy: boolean) => void): () => void {
  const listen = desktopTools()?.onLoadChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback(Boolean(row?.busy)));
}
