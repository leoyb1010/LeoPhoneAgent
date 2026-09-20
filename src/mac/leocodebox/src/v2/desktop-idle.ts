type DesktopIdleTools = {
  onIdleBack?: (callback: (row: { back?: boolean }) => void) => () => void;
};

function desktopTools(): DesktopIdleTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function onIdleBack(callback: () => void): () => void {
  const listen = desktopTools()?.onIdleBack;
  if (!listen) return () => undefined;
  return listen(() => callback());
}
