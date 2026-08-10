import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { LEOCODEBOX_WORDMARK_FONT_FAMILY } from '../../../../constants/branding';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';
import { LEO_RELEASE_NOTES } from '../../../version-upgrade/releaseNotes';

import RecoverySection from './RecoverySection';

const OWNER_URL = 'https://github.com/leoyb1010';

function updateStatusText(state: DesktopUpdateState | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!window.leocodeboxDesktopUpdater) return t('about.browserUnsupported');
  switch (state?.status) {
    case 'authentication-required': return t('about.authRequired');
    case 'checking': return t('about.checking');
    case 'available': return t('about.available', { version: state.latestVersion });
    case 'downloading': return t('about.downloading', { progress: state.progress === null ? '' : ` ${state.progress}%` });
    case 'downloaded': return t('about.downloaded', { version: state.latestVersion });
    case 'installing': return t('about.installing');
    case 'up-to-date': return t('about.upToDate');
    case 'development-build': return t('about.development');
    case 'error': return t('about.error');
    default: return state?.configured ? t('about.enabled') : t('about.notConfigured');
  }
}

export default function AboutTab() {
  const { t } = useTranslation('settings');
  const {
    currentVersion,
    desktopUpdate,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    setGithubToken,
  } = useVersionCheck();
  const [token, setToken] = useState('');
  const [actionError, setActionError] = useState('');
  const [savingToken, setSavingToken] = useState(false);

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveToken = async () => {
    if (!token.trim()) return;
    setSavingToken(true);
    await runAction(async () => {
      await setGithubToken(token);
      setToken('');
      await checkForUpdates();
    });
    setSavingToken(false);
  };

  const isBusy = desktopUpdate?.status === 'checking'
    || desktopUpdate?.status === 'downloading'
    || desktopUpdate?.status === 'installing';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="leocodebox" className="h-10 w-10" />
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: LEOCODEBOX_WORDMARK_FONT_FAMILY }}
            >
              leocodebox
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
            <span className="text-[11px] text-muted-foreground">by LeoYuan</span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('about.description')}</p>
        </div>
      </div>

      <section className="border-y border-border/60 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t('about.updates')}</h3>
            <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">{updateStatusText(desktopUpdate, t)}</p>
          </div>
          {desktopUpdate?.status === 'up-to-date' && <CheckCircle2 className="h-5 w-5 text-success" />}
        </div>

        {window.leocodeboxDesktopUpdater && desktopUpdate?.credentialRequired && !desktopUpdate.configured && (
          <div className="mt-4 space-y-2">
            <label className="text-xs font-medium text-foreground" htmlFor="github-update-token">
              {t('about.tokenLabel')}
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  id="github-update-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={t('about.tokenPlaceholder')}
                  autoComplete="off"
                  className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                type="button"
                disabled={!token.trim() || savingToken}
                onClick={() => void saveToken()}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {savingToken ? t('about.saving') : t('about.saveCheck')}
              </button>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {t('about.privateNote')}
            </p>
          </div>
        )}

        {desktopUpdate?.progress !== null && desktopUpdate?.status === 'downloading' && (
          <div
            role="progressbar"
            aria-label={t('about.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={desktopUpdate.progress}
            className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${desktopUpdate.progress}%` }} />
          </div>
        )}

        {(actionError || desktopUpdate?.error) && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-xs text-destructive">{actionError || desktopUpdate?.error}</p>
        )}

        {window.leocodeboxDesktopUpdater && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isBusy || !desktopUpdate?.configured}
              onClick={() => void runAction(checkForUpdates)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              {desktopUpdate?.status === 'checking'
                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              {t('about.check')}
            </button>
            {desktopUpdate?.status === 'available' && (
              <button
                type="button"
                onClick={() => void runAction(downloadUpdate)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
              >
                <Download className="h-4 w-4" />{t('about.download')}
              </button>
            )}
            {desktopUpdate?.status === 'downloaded' && (
              <button
                type="button"
                onClick={() => void runAction(installUpdate)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
              >
                <RotateCcw className="h-4 w-4" />{t('about.restartInstall')}
              </button>
            )}
            {desktopUpdate?.configured && desktopUpdate.credentialRequired && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void runAction(() => setGithubToken(''))}
                className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />{t('about.removeCredential')}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="border-b border-border/60 pb-5">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-foreground">{t('about.recentUpdates')}</h3>
        </div>
        {/* [T-release-notes] 更新记录读随包内置的 LEO_RELEASE_NOTES。
            原来这里读 GitHub Release——内部迭代不发 release,列表永远是空的,
            用户点进"关于"看不到任何实际记录。 */}
        <div className="space-y-3">
          {LEO_RELEASE_NOTES.map((note) => (
            <div key={note.version} className="rounded-md border border-border px-4 py-3">
              <p className="text-xs text-muted-foreground">
                v{note.version} · {note.date}
                {note.version === currentVersion ? ` · ${t('about.currentRelease')}` : ''}
              </p>
              <ul className="mt-2 space-y-1.5">
                {note.items.map((item) => (
                  <li key={item} className="flex gap-2 text-sm leading-relaxed text-foreground">
                    <span className="text-muted-foreground">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <RecoverySection />

      <div className="text-sm text-muted-foreground">
        <p>{t('about.localData')}</p>
      </div>

      <a
        href={OWNER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        GitHub
        <ExternalLink className="h-3.5 w-3.5" />
      </a>

      <div className="flex gap-4 text-xs text-muted-foreground/70">
        <a href="/LICENSE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">LICENSE</a>
        <a href="/NOTICE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{t('about.notice')}</a>
      </div>
    </div>
  );
}
