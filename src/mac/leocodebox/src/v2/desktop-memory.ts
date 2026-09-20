type MemoryRow = { low?: boolean; can?: boolean };

type DesktopMemoryTools = {
  getMemory?: () => Promise<MemoryRow>;
  onMemoryChanged?: (callback: (row: MemoryRow) => void) => () => void;
};

function desktopTools(): DesktopMemoryTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function readMemory(): Promise<boolean> {
  const get = desktopTools()?.getMemory;
  if (!get) return false;
  const row = await get();
  return Boolean(row?.low);
}

export function onMemoryChanged(callback: (low: boolean) => void): () => void {
  const listen = desktopTools()?.onMemoryChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback(Boolean(row?.low)));
}
