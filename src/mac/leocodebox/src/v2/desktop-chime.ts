type DesktopChimeTools = {
  playDoneSound?: () => Promise<{ ok?: boolean }>;
};

function desktopTools(): DesktopChimeTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopChimeTools(): DesktopChimeTools | undefined {
  return desktopTools();
}

export async function playSessionChime(): Promise<void> {
  const play = desktopTools()?.playDoneSound;
  if (!play) throw new Error('这台电脑现在响不了');
  await play();
}
