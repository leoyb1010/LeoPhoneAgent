import type { UpdateRow } from './session-update';

type DesktopUpdater = {
  getState?: () => Promise<UpdateRow>;
  checkForUpdates?: () => Promise<UpdateRow>;
  downloadUpdate?: () => Promise<UpdateRow>;
  installUpdate?: () => Promise<UpdateRow>;
  onStateChanged?: (callback: (row: UpdateRow) => void) => () => void;
};

function updater(): DesktopUpdater | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopUpdater;
}

export function desktopUpdater(): DesktopUpdater | undefined {
  return updater();
}

export async function runDesktopUpdate(action: 'check' | 'download' | 'install'): Promise<UpdateRow> {
  const bridge = updater();
  const run = action === 'download'
    ? bridge?.downloadUpdate
    : action === 'install'
      ? bridge?.installUpdate
      : bridge?.checkForUpdates;
  if (!run) throw new Error('这台电脑现在不能检查更新');
  return run();
}
