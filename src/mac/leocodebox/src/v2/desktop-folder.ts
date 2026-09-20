import { api } from './api';

type DesktopFolderTools = {
  pickFolder?: () => Promise<{ path?: string; cancelled?: boolean }>;
  revealPath?: (target: string) => Promise<unknown>;
};

function desktopTools(): DesktopFolderTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function pickSessionFolder(): Promise<string | null> {
  const desktop = desktopTools()?.pickFolder;
  if (desktop) {
    const row = await desktop();
    if (row?.cancelled) return null;
    if (row?.path?.trim()) return row.path.trim();
  }
  const row = await api.pickLocalFolder();
  if ('cancelled' in row && row.cancelled) return null;
  return 'path' in row ? row.path : null;
}

export async function revealSessionPath(target: string): Promise<void> {
  const next = target.trim();
  if (!next) throw new Error('没有路径');
  const desktop = desktopTools()?.revealPath;
  if (desktop) {
    await desktop(next);
    return;
  }
  await api.revealLocalPath(next);
}
