type DesktopAwakeTools = {
  keepAwake?: (on: boolean) => Promise<unknown>;
};

function desktopTools(): DesktopAwakeTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function setSessionKeepAwake(on: boolean): Promise<void> {
  const keep = desktopTools()?.keepAwake;
  if (keep) await keep(Boolean(on));
}
