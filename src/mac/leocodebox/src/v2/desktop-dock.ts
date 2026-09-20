type DesktopDockTools = {
  onDockNew?: (callback: () => void) => () => void;
};

function desktopTools(): DesktopDockTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopDockTools(): DesktopDockTools | undefined {
  return desktopTools();
}

export function onDockNew(callback: () => void): () => void {
  const listen = desktopTools()?.onDockNew;
  if (!listen) return () => undefined;
  return listen(callback);
}
