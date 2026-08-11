import { Download, ExternalLink, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

import { useVersionCheck } from '../../../hooks/useVersionCheck';

interface VersionUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function VersionUpgradeModal({ isOpen, onClose }: VersionUpgradeModalProps) {
  const { t } = useTranslation('settings');
  const {
    currentVersion,
    latestVersion,
    releaseInfo,
    releaseHistory,
    desktopUpdate,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
  } = useVersionCheck();

  if (!isOpen) return null;

  const status = desktopUpdate?.status;
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label={t('about.close')} />
      <div className="relative max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-elevation-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('about.modalTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('about.currentVersion', { current: currentVersion })}{latestVersion ? t('about.latestVersion', { latest: latestVersion }) : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label={t('about.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {releaseInfo?.body ? (
          <div className="prose prose-sm mt-5 max-w-none rounded-md border border-border bg-muted/30 p-4 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{releaseInfo.body}</ReactMarkdown>
          </div>
        ) : (
          <p className="mt-5 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">{t('about.noReleaseNotes')}</p>
        )}

        {releaseInfo?.htmlUrl && (
          <a href={releaseInfo.htmlUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            {t('about.viewRelease')} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        {releaseHistory.length > 0 && (
          <details className="mt-6 rounded-md border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground">{t('about.recentUpdates')}</summary>
            <div className="mt-4 space-y-4">
              {releaseHistory.map((release) => (
                <article key={release.version} className="border-t border-border pt-3 first:border-0 first:pt-0">
                  <h3 className="text-sm font-medium text-foreground">{release.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">v{release.version}{release.version === currentVersion ? ` · ${t('about.currentRelease')}` : ''}</p>
                  <div className="prose-xs prose mt-2 max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{release.body}</ReactMarkdown></div>
                </article>
              ))}
            </div>
          </details>
        )}

        {status === 'downloading' && (
          <div className="mt-5">
            <div className="mb-2 flex justify-between text-xs text-muted-foreground">
              <span>{t('about.downloadingBackground')}</span><span>{desktopUpdate?.progress ?? 0}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${desktopUpdate?.progress ?? 0}%` }} />
            </div>
          </div>
        )}

        {status === 'authentication-required' && (
          <p className="mt-5 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning dark:text-warning">
            {t('about.authNotice')}
          </p>
        )}
        {desktopUpdate?.error && (
          <p className="mt-5 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {desktopUpdate.error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent">
            {t('about.later')}
          </button>
          {status === 'available' && (
            <button type="button" onClick={() => void downloadUpdate()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              <Download className="h-4 w-4" />{t('about.backgroundDownload')}
            </button>
          )}
          {status === 'downloaded' && (
            <button type="button" onClick={() => void installUpdate()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              <RotateCcw className="h-4 w-4" />{t('about.restartInstall')}
            </button>
          )}
          {(status === 'error' || status === 'up-to-date' || status === 'idle') && (
            <button
              type="button"
              disabled={busy || !desktopUpdate?.configured}
              onClick={() => void checkForUpdates()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('about.recheck')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
