type DesktopPrintTools = {
  printText?: (payload: { title?: string; text: string }) => Promise<unknown>;
};

function desktopTools(): DesktopPrintTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function printSessionTalk(title: string, text: string): Promise<void> {
  const print = desktopTools()?.printText;
  if (!print) throw new Error('这台电脑现在打不了');
  await print({ title, text });
}
