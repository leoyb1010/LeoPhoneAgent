import { useCallback, useEffect, useState } from 'react';

import { version } from '../../package.json';
import { releaseHistory } from '../data/releaseHistory';
import type { ReleaseInfo } from '../types/sharedTypes';

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = (_owner?: string, _repo?: string) => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== version);
        }
      } catch {
        // The desktop updater still works when the local health check is temporarily unavailable.
      }
    };

    void fetchHealth();
  }, []);

  useEffect(() => {
    const bridge = window.leocodeboxDesktopUpdater;
    if (!bridge) return undefined;

    let active = true;
    void bridge.getState().then((state) => {
      if (active) setDesktopUpdate(state);
    });
    const unsubscribe = bridge.onStateChanged((state) => {
      if (active) setDesktopUpdate(state);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const callUpdater = useCallback(async (
    operation: (bridge: NonNullable<typeof window.leocodeboxDesktopUpdater>) => Promise<DesktopUpdateState>,
  ) => {
    const bridge = window.leocodeboxDesktopUpdater;
    if (!bridge) return null;
    const state = await operation(bridge);
    setDesktopUpdate(state);
    return state;
  }, []);

  const checkForUpdates = useCallback(
    () => callUpdater((bridge) => bridge.checkForUpdates()),
    [callUpdater],
  );
  const downloadUpdate = useCallback(
    () => callUpdater((bridge) => bridge.downloadUpdate()),
    [callUpdater],
  );
  const installUpdate = useCallback(
    () => callUpdater((bridge) => bridge.installUpdate()),
    [callUpdater],
  );
  const setGithubToken = useCallback(
    (token: string) => callUpdater((bridge) => bridge.setGithubToken(token)),
    [callUpdater],
  );

  const updateAvailable = desktopUpdate
    ? ['available', 'downloading', 'downloaded', 'installing'].includes(desktopUpdate.status)
    : false;
  const latestVersion = desktopUpdate?.latestVersion || null;
  const releaseInfo: ReleaseInfo | null = desktopUpdate?.releaseNotes || desktopUpdate?.releaseName
    ? {
        version: latestVersion || undefined,
        title: desktopUpdate.releaseName || (latestVersion ? `leocodebox v${latestVersion}` : 'leocodebox update'),
        body: desktopUpdate.releaseNotes || '',
        summary: desktopUpdate.releaseNotes?.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))?.trim() || '',
        htmlUrl: latestVersion
          ? `https://github.com/leoyb1010/leocodebox/releases/tag/v${latestVersion}`
          : 'https://github.com/leoyb1010/leocodebox/releases',
        publishedAt: '',
      }
    : null;

  return {
    updateAvailable,
    latestVersion,
    currentVersion: desktopUpdate?.currentVersion || version,
    releaseInfo,
    releaseHistory,
    installMode,
    runningVersion,
    restartRequired,
    desktopUpdate,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    setGithubToken,
  };
};
