type DesktopNetpathTools = {
  onNetpathChanged?: (callback: () => void) => () => void;
};

function desktopTools(): DesktopNetpathTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function onNetpathChanged(callback: () => void): () => void {
  const listen = desktopTools()?.onNetpathChanged;
  if (!listen) return () => undefined;
  return listen(callback);
}
