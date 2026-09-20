type DesktopA11yTools = {
  openAccessibility?: () => Promise<{ ok?: boolean; url?: string }>;
};

function desktopTools(): DesktopA11yTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export function desktopA11yTools(): DesktopA11yTools | undefined {
  return desktopTools();
}

export async function openDesktopAccessibility(): Promise<string> {
  const open = desktopTools()?.openAccessibility;
  if (!open) throw new Error('这台电脑现在打不开辅助功能设置');
  const row = await open();
  return String(row?.url ?? '');
}
