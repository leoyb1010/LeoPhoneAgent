type DisplayRow = { kind?: string; count?: number };

type DesktopDisplayTools = {
  onDisplayChanged?: (callback: (row: DisplayRow) => void) => () => void;
};

function desktopTools(): DesktopDisplayTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function onDisplayChanged(callback: (row: DisplayRow) => void): () => void {
  const listen = desktopTools()?.onDisplayChanged;
  if (!listen) return () => undefined;
  return listen((row) => callback({ kind: String(row?.kind || ''), count: Number(row?.count) || 0 }));
}
