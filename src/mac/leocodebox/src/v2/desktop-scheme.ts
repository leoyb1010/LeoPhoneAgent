type DesktopSchemeTools = {
  onLeoScheme?: (callback: (row: { cwd?: string | null }) => void) => () => void;
};

function desktopTools(): DesktopSchemeTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function onLeoScheme(callback: (cwd: string) => void): () => void {
  const listen = desktopTools()?.onLeoScheme;
  if (!listen) return () => undefined;
  return listen((row) => {
    const cwd = row.cwd?.trim();
    if (!cwd) return;
    callback(cwd);
  });
}
