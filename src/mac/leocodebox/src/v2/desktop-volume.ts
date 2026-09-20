type VolumeRow = { kind?: string; count?: number };

type DesktopVolumeTools = {
  onVolumeChanged?: (callback: (row: VolumeRow) => void) => () => void;
};

function desktopTools(): DesktopVolumeTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function onVolumeChanged(callback: (row: VolumeRow) => void): () => void {
  const listen = desktopTools()?.onVolumeChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback({ kind: String(row?.kind || ''), count: Number(row?.count) || 0 }));
}
