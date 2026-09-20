type DesktopEmojiTools = {
  showEmojiPanel?: () => Promise<{ ok?: boolean }>;
};

function desktopTools(): DesktopEmojiTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopEmojiTools(): DesktopEmojiTools | undefined {
  return desktopTools();
}

export async function openDesktopEmoji(): Promise<void> {
  const run = desktopTools()?.showEmojiPanel;
  if (!run) throw new Error('这台电脑现在弹不出表情');
  await run();
}
