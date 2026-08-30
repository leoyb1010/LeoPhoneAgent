import { useCallback, useEffect, useState } from 'react';
import { Database, FileArchive, HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../../utils/apiClient';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type CacheKind = 'body' | 'attachment';

type TreasuryStorageUsage = {
  original_bytes: number;
  original_files: number;
  body_cache_bytes: number;
  body_cache_entries: number;
  attachment_cache_bytes: number;
  attachment_cache_files: number;
  attachment_cache_entries: number;
};

const EMPTY_USAGE: TreasuryStorageUsage = {
  original_bytes: 0,
  original_files: 0,
  body_cache_bytes: 0,
  body_cache_entries: 0,
  attachment_cache_bytes: 0,
  attachment_cache_files: 0,
  attachment_cache_entries: 0,
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${units[power]}`;
}

export default function StorageSettingsTab() {
  const { t } = useTranslation('settings');
  const [usage, setUsage] = useState<TreasuryStorageUsage>(EMPTY_USAGE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CacheKind | null>(null);
  const [confirmKind, setConfirmKind] = useState<CacheKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{ usage: TreasuryStorageUsage }>('/api/treasury/storage', undefined, signal);
      setUsage(response.usage);
    } catch {
      if (signal?.aborted) return;
      setError(t('storage.loadError', {
        defaultValue: 'Unable to read Treasury storage usage.',
      }));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const clearCache = useCallback(async () => {
    if (!confirmKind || busy) return;
    const kind = confirmKind;
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      const response = await apiClient.delete<{ usage: TreasuryStorageUsage }>(
        `/api/treasury/storage/cache/${kind}`,
      );
      setUsage(response.usage);
      setConfirmKind(null);
      setMessage(t('storage.cleared', { defaultValue: 'Cache cleared. Original Treasury files were preserved.' }));
    } catch {
      setConfirmKind(null);
      setError(t('storage.clearError', {
        defaultValue: 'Unable to clear the cache.',
      }));
    } finally {
      setBusy(null);
    }
  }, [busy, confirmKind, t]);

  const cacheBytes = confirmKind === 'body' ? usage.body_cache_bytes : usage.attachment_cache_bytes;
  const cacheLabel = confirmKind === 'body'
    ? t('storage.bodyCache.label', { defaultValue: 'Phone body cache' })
    : t('storage.attachmentCache.label', { defaultValue: 'Phone attachment cache' });

  return (
    <div className="space-y-6 md:space-y-8">
      <SettingsSection
        title={t('storage.title', { defaultValue: 'Treasury storage' })}
        description={t('storage.description', {
          defaultValue: 'Inspect local originals and clear only phone content that can be downloaded again.',
        })}
      >
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" disabled={loading || busy !== null} onClick={() => void load()}>
            {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {t('storage.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>

        <div aria-live="polite" aria-busy={loading}>
          {error && (
            <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {message && (
            <div role="status" className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {message}
            </div>
          )}

          <SettingsCard divided>
            <SettingsRow
              className="flex-col items-stretch sm:flex-row sm:items-center"
              label={t('storage.originals.label', { defaultValue: 'Local original files' })}
              description={t('storage.originals.description', {
                defaultValue: 'Durable files captured on this Mac. They are read-only here and are never cleanup targets.',
              })}
            >
              <div className="flex items-center justify-between gap-2 text-sm text-foreground sm:justify-start">
                <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {loading ? (
                  <span aria-label={t('storage.loading', { defaultValue: 'Loading' })}
                    className="h-4 w-24 animate-pulse rounded-md bg-muted" />
                ) : (
                  <>
                    <span>{formatBytes(usage.original_bytes)}</span>
                    <span className="text-xs text-muted-foreground">· {t('storage.fileCount', {
                      defaultValue: '{{count}} files', count: usage.original_files,
                    })}</span>
                  </>
                )}
              </div>
            </SettingsRow>

            <SettingsRow
              className="flex-col items-stretch sm:flex-row sm:items-center"
              label={t('storage.bodyCache.label', { defaultValue: 'Phone body cache' })}
              description={t('storage.bodyCache.description', {
                defaultValue: 'Downloaded article, note, OCR, and transcript text. It can be fetched again when the phone is online.',
              })}
            >
              <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <Database className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {loading ? (
                    <span aria-label={t('storage.loading', { defaultValue: 'Loading' })}
                      className="h-4 w-24 animate-pulse rounded-md bg-muted" />
                  ) : (
                    <>
                      {formatBytes(usage.body_cache_bytes)}
                      <span className="text-xs text-muted-foreground">· {t('storage.entryCount', {
                        defaultValue: '{{count}} entries', count: usage.body_cache_entries,
                      })}</span>
                    </>
                  )}
                </span>
                <Button type="button" variant="outline" size="sm"
                  disabled={loading || busy !== null || usage.body_cache_entries === 0}
                  onClick={() => setConfirmKind('body')}>
                  {busy === 'body' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {t('storage.clear', { defaultValue: 'Clear' })}
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow
              className="flex-col items-stretch sm:flex-row sm:items-center"
              label={t('storage.attachmentCache.label', { defaultValue: 'Phone attachment cache' })}
              description={t('storage.attachmentCache.description', {
                defaultValue: 'Downloaded PDFs, images, documents, audio, and video references. Originals remain on their source device.',
              })}
            >
              <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <FileArchive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {loading ? (
                    <span aria-label={t('storage.loading', { defaultValue: 'Loading' })}
                      className="h-4 w-24 animate-pulse rounded-md bg-muted" />
                  ) : (
                    <>
                      {formatBytes(usage.attachment_cache_bytes)}
                      <span className="text-xs text-muted-foreground">· {t('storage.fileCount', {
                        defaultValue: '{{count}} files', count: usage.attachment_cache_files,
                      })}</span>
                    </>
                  )}
                </span>
                <Button type="button" variant="outline" size="sm"
                  disabled={loading || busy !== null || (
                    usage.attachment_cache_files === 0 && usage.attachment_cache_entries === 0
                  )}
                  onClick={() => setConfirmKind('attachment')}>
                  {busy === 'attachment' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {t('storage.clear', { defaultValue: 'Clear' })}
                </Button>
              </div>
            </SettingsRow>
          </SettingsCard>
        </div>
      </SettingsSection>

      <Dialog open={confirmKind !== null} onOpenChange={(open) => {
        if (!open && busy === null) setConfirmKind(null);
      }}>
        <DialogContent
          aria-labelledby="treasury-cache-confirm-title"
          aria-describedby="treasury-cache-confirm-description"
          className="max-w-md p-0"
        >
          <DialogTitle id="treasury-cache-confirm-title">
            {t('storage.confirm.title', { defaultValue: 'Clear Treasury cache?' })}
          </DialogTitle>
          <div className="space-y-4 p-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('storage.confirm.title', { defaultValue: 'Clear Treasury cache?' })}
              </h3>
              <p id="treasury-cache-confirm-description" className="mt-2 text-sm leading-6 text-muted-foreground">
                {t('storage.confirm.description', {
                  defaultValue: 'Clear {{label}} ({{size}})? Local original files and Treasury items will not be deleted.',
                  label: cacheLabel,
                  size: formatBytes(cacheBytes),
                })}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setConfirmKind(null)}>
                {t('storage.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => void clearCache()}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                {t('storage.clearConfirm', { defaultValue: 'Clear cache' })}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
