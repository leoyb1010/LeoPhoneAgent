import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { apiClient } from '../../../../../utils/apiClient';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

type BrowserUseSettings = {
  enabled: boolean;
};

type BrowserUseStatus = {
  enabled: boolean;
  available: boolean;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  installInProgress: boolean;
  message: string;
};

export default function BrowserUseSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<BrowserUseSettings | null>(null);
  const [status, setStatus] = useState<BrowserUseStatus | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const settingsData = await apiClient.get<{ data: { settings: BrowserUseSettings } }>(
      '/api/browser-use/settings',
    );
    setSettings(settingsData.data.settings);
  }, []);

  const loadStatus = useCallback(async () => {
    const statusData = await apiClient.get<{ data: BrowserUseStatus }>('/api/browser-use/status');
    setStatus(statusData.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);

    void loadSettings()
      .catch((err) => setError(err instanceof Error ? err.message : t('browserUse.loadSettingsError')))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(err instanceof Error ? err.message : t('browserUse.loadStatusError')))
      .finally(() => setIsStatusLoading(false));
  }, [loadSettings, loadStatus, t]);

  const updateSettings = async (nextSettings: Partial<BrowserUseSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await apiClient.put<{ data: { settings: BrowserUseSettings } }>(
        '/api/browser-use/settings',
        nextSettings,
      );
      setSettings(data.data.settings);
      window.dispatchEvent(new Event('browserUseSettingsChanged'));
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('browserUse.saveError'));
    } finally {
      setIsStatusLoading(false);
      setIsSaving(false);
    }
  };

  const installBrowserBinaries = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      await apiClient.post('/api/browser-use/runtime/install');
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('browserUse.installError'));
    } finally {
      setIsStatusLoading(false);
      setIsInstalling(false);
    }
  };

  const runtimeMessage = (message?: string) => {
    switch (message) {
      case 'Install Playwright and Chromium to use browser sessions.': return t('browserUse.runtimeInstallBoth');
      case 'Playwright is installed, but Chromium is missing. Install the Chromium runtime to continue.': return t('browserUse.runtimeChromiumMissing');
      case 'Browser runtime is not ready.': return t('browserUse.runtimeNotReady');
      case 'Browser runtime is available.': return t('browserUse.runtimeReady');
      default: return message || t('browserUse.runtimeDefault');
    }
  };

  const browserEnabled = settings?.enabled === true;
  const needsBrowserBinaries = Boolean(browserEnabled && status && (!status.playwrightInstalled || !status.chromiumInstalled));
  const runtimeLabel = (installed?: boolean) => {
    if (isStatusLoading && !status) {
      return t('browserUse.checking');
    }
    return installed ? t('browserUse.installed') : t('browserUse.notInstalled');
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('browserUse.title')}
        description={t('browserUse.description')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('browserUse.enable')}
            description={t('browserUse.enableDescription')}
          >
            {isSettingsLoading && !settings ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={browserEnabled}
                onChange={(value) => void updateSettings({ enabled: value })}
                ariaLabel={t('browserUse.enableAria')}
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border px-2 py-1">
                {t('browserUse.playwright')}: {runtimeLabel(status?.playwrightInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                {t('browserUse.chromium')}: {runtimeLabel(status?.chromiumInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                {t('browserUse.status')}：{isStatusLoading && !status ? t('browserUse.checking') : status?.available ? t('browserUse.available') : browserEnabled ? t('browserUse.needsInstall') : t('browserUse.disabled')}
              </span>
            </div>

            {needsBrowserBinaries && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground">{t('browserUse.runtimeRequired')}</div>
                  <p className="text-sm text-muted-foreground">
                    {runtimeMessage(status?.message)}
                  </p>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => void installBrowserBinaries()}
                  disabled={isInstalling || status?.installInProgress}
                  className="flex-shrink-0"
                >
                  {isInstalling || status?.installInProgress ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {isInstalling || status?.installInProgress ? t('browserUse.installing') : t('browserUse.install')}
                </Button>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-destructive bg-destructive px-3 py-2 text-sm text-destructive dark:border-destructive/50 dark:bg-destructive/30 dark:text-destructive">
                {error}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
