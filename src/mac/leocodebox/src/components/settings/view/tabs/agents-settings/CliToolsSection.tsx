import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpCircle, CheckCircle2, CircleHelp, Copy, FileDown, Loader2, Play, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient, apiRequest  } from '../../../../../utils/apiClient';
import { cn } from '../../../../../lib/utils';
import SessionProviderLogo from '../../../../llm-logo-provider/SessionProviderLogo';

export type CliCopyInfo = {
  path: string;
  realPath: string;
  version: string | null;
  source: string;
  active: boolean;
};

export type CliToolStatus = {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  runnable: boolean;
  error: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  latestCheckedAt?: string | null;
  latestVersionSource?: string;
  installSource: string;
  executablePath: string | null;
  copies?: CliCopyInfo[];
  /** True only when the copy that actually runs is behind a newer shadowed copy. */
  hasNewerShadowCopy?: boolean;
  /** Highest version across all copies (server-computed with semver order). */
  newestCopyVersion?: string | null;
  canInstall: boolean;
  canSelfUpdate: boolean;
  canLaunch?: boolean;
  mutationsAllowed: boolean;
  manualHint?: string | null;
  docsUrl?: string;
};

type CliToolsSectionProps = { onToolsChange?: (tools: CliToolStatus[]) => void };

type CliStatusResponse = {
  success: boolean;
  tools: CliToolStatus[];
  checkedAt?: string;
  mutationsAllowed?: boolean;
  /** true = served from the on-disk snapshot while a live probe refreshes it. */
  stale?: boolean;
};

type CliActionResponse = {
  success?: boolean;
  error?: string;
  changed?: boolean;
  currentVersion?: string | null;
  notice?: string | null;
  activePath?: string | null;
  output?: string;
};

/**
 * Live view of the locally installed agent CLIs: current version, whether a
 * newer version exists on the registry, and a one-click self-update button.
 */
export default function CliToolsSection({ onToolsChange }: CliToolsSectionProps) {
  const { t, i18n } = useTranslation('settings');
  const [tools, setTools] = useState<CliToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [mutationsAllowed, setMutationsAllowed] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const staleRefetchTimer = useRef<number | null>(null);

  const load = useCallback(async (forceLatest = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest(`/api/leocodebox/cli/status${forceLatest ? '?refresh=1' : ''}`) as CliStatusResponse;
      if (data?.success && Array.isArray(data.tools)) {
        setTools(data.tools);
        onToolsChange?.(data.tools);
        setCheckedAt(data.checkedAt || new Date().toISOString());
        setMutationsAllowed(Boolean(data.mutationsAllowed));
        // Snapshot responses (stale:true) render instantly while the server
        // re-probes in the background; silently pick up the fresh result once.
        if (data.stale && staleRefetchTimer.current === null) {
          staleRefetchTimer.current = window.setTimeout(async () => {
            staleRefetchTimer.current = null;
            try {
              const fresh = await apiRequest('/api/leocodebox/cli/status') as CliStatusResponse;
              if (fresh?.success && Array.isArray(fresh.tools)) {
                setTools(fresh.tools);
                onToolsChange?.(fresh.tools);
                setCheckedAt(fresh.checkedAt || new Date().toISOString());
              }
            } catch { /* the visible snapshot stays; manual refresh still works */ }
          }, 8000);
        }
      }
    } catch (error) {
      console.error('Failed to load CLI status:', error);
      setLoadError(error instanceof Error ? error.message : t('agents.cliTools.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [onToolsChange, t]);

  useEffect(() => () => {
    if (staleRefetchTimer.current !== null) window.clearTimeout(staleRefetchTimer.current);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load, t]);

  // 一键诊断包: masked CLI/Leoapi state as a shareable JSON download.
  const exportDiagnostics = useCallback(async () => {
    try {
      const response = await apiClient.get<{ success: boolean; report: unknown }>('/api/leocodebox/diagnostics');
      if (!response?.success) throw new Error('diagnostics export failed');
      const blob = new Blob([JSON.stringify(response.report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `leocodebox-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export diagnostics:', error);
    }
  }, []);

  const runAction = useCallback(async (tool: CliToolStatus, action: 'install' | 'update') => {
    setUpdating(tool.id);
    setMessage(null);
    setDetail(null);
    try {
      const data = await apiRequest(`/api/leocodebox/cli/${tool.id}/${action}`, {
        method: 'POST',
      }) as CliActionResponse;
      if (data?.success) {
        const base = action === 'install'
          ? t('agents.cliTools.installSuccess', { tool: tool.label, version: data.currentVersion || '' })
          : data.changed
            ? t('agents.cliTools.updateSuccess', { tool: tool.label, version: data.currentVersion ?? t('agents.cliTools.latestVersion') })
            : t('agents.cliTools.alreadyLatest', { tool: tool.label, version: data.currentVersion ?? tool.currentVersion ?? '' });
        setMessage(data.notice ? `${base}\n${data.notice}` : base);
      } else {
        const failure = t('agents.cliTools.actionFailed', { tool: tool.label, action: t(`agents.cliTools.${action}`), error: data?.error ?? t('agents.cliTools.unknownError') });
        setMessage(data?.notice ? `${failure}\n${data.notice}` : failure);
      }
      if (data?.output) setDetail(data.output);
    } catch (error) {
      setMessage(t('agents.cliTools.actionFailed', { tool: tool.label, action: t(`agents.cliTools.${action}`), error: error instanceof Error ? error.message : t('agents.cliTools.unknownError') }));
    } finally {
      setUpdating(null);
      void load(false);
    }
  }, [load, t]);

  const updateable = tools.filter((tool) => tool.installed && tool.runnable && tool.canSelfUpdate
    && tool.updateAvailable);

  const updateAll = useCallback(async () => {
    for (const tool of updateable) await runAction(tool, 'update');
  }, [runAction, updateable]);

  const launchCodexHost = useCallback(async () => {
    setUpdating('codexhost-launch');
    setMessage(null);
    try {
      const data = await apiRequest('/api/leocodebox/cli/codexhost/launch', { method: 'POST' }) as CliActionResponse;
      setMessage(data?.success ? t('agents.cliTools.launchSuccess') : (data?.error ?? t('agents.cliTools.unknownError')));
    } catch (error) {
      setMessage(t('agents.cliTools.actionFailed', { tool: 'CodexHost', action: t('agents.cliTools.launch'), error: error instanceof Error ? error.message : t('agents.cliTools.unknownError') }));
    } finally {
      setUpdating(null);
    }
  }, [t]);

  return (
    <div className="border-b border-border/60 bg-muted/20 px-4 py-3 md:px-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('agents.cliTools.title')}</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void exportDiagnostics()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t('agents.cliTools.diagnosticsHint')}
          >
            <FileDown className="h-3 w-3" />
            {t('agents.cliTools.diagnostics')}
          </button>
          <button
            onClick={() => void load(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t('agents.cliTools.refresh')}
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            {t('agents.cliTools.refresh')}
          </button>
        </div>
      </div>
      {!mutationsAllowed && !loading && (
        <p className="mb-2 text-[11px] text-muted-foreground">{t('agents.cliTools.desktopOnly')}</p>
      )}
      {checkedAt && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          {t('agents.cliTools.versionCheck', { time: new Date(checkedAt).toLocaleString(i18n.language) })} · {t('agents.cliTools.cacheHint')}
        </p>
      )}

      {loading && tools.length === 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label={t('agents.cliTools.loading')}>
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-[58px] animate-pulse rounded-md bg-muted/70" />)}
        </div>
      ) : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tools.map((tool) => (
          <div
            key={tool.id}
            id={`cli-tool-${tool.id}`}
            className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SessionProviderLogo provider={tool.id} className="h-4 w-4 flex-shrink-0" />
                <span className="truncate text-sm font-medium text-foreground">{tool.label}</span>
                {tool.installed && tool.runnable ? (
                  tool.updateAvailable ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning dark:text-warning">
                      <ArrowUpCircle className="h-3 w-3" />
                      {t('agents.cliTools.updateAvailable')}
                    </span>
                  ) : ['registry', 'cache', 'stale-cache'].includes(tool.latestVersionSource || '') ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success dark:text-success">
                      <CheckCircle2 className="h-3 w-3" />
                      {t('agents.cliTools.latest')}
                    </span>
                  ) : tool.latestVersionSource === 'unsupported' ? (
                    // Not a failure: this CLI publishes no registry we can query,
                    // it updates itself via its own `update` command. Saying
                    // 无法检查 made a perfectly healthy tool look broken.
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <RefreshCw className="h-3 w-3" />
                      {t('agents.cliTools.selfUpdate')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <CircleHelp className="h-3 w-3" />
                      {t('agents.cliTools.unavailable')}
                    </span>
                  )
                ) : tool.installed ? (
                  <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive dark:text-destructive">{t('agents.cliTools.notRunnable')}</span>
                ) : (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('agents.cliTools.notInstalled')}</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {tool.installed && tool.runnable ? (
                  <>
                    {t('agents.cliTools.currentVersion', { version: tool.currentVersion ?? t('agents.cliTools.unknownVersion'), source: tool.installSource || t('agents.cliTools.unknownSource') })}
                    {tool.updateAvailable && tool.latestVersion ? ` → ${t('agents.cliTools.latestVersionLabel', { version: tool.latestVersion })}` : ''}
                  </>
                ) : tool.installed ? (
                  <span title={tool.error ?? undefined}>{tool.error || t('agents.cliTools.commandDetectedFailed')}</span>
                ) : (
                  <span>{t('agents.cliTools.commandMissing', { command: tool.command })}</span>
                )}
              </div>
              {tool.hasNewerShadowCopy && tool.copies && tool.copies.length > 1 && (
                <p
                  className="mt-0.5 truncate text-[10px] text-warning dark:text-warning"
                  title={tool.copies.map((copy) => `${copy.active ? '● ' : '○ '}${copy.path} → ${copy.version ?? '?'}（${copy.source}）`).join('\n')}
                >
                  {t('agents.cliTools.multipleCopies', {
                    active: tool.currentVersion ?? '?',
                    newest: tool.newestCopyVersion ?? '?',
                  })}
                </p>
              )}
            </div>

            {tool.installed && tool.runnable && tool.canSelfUpdate && (
              <button
                onClick={() => void runAction(tool, 'update')}
                disabled={updating !== null || !mutationsAllowed}
                title={!mutationsAllowed ? t('agents.cliTools.desktopOnly') : undefined}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
                {tool.updateAvailable ? t('agents.cliTools.update') : t('agents.cliTools.checkAndUpdate')}
              </button>
            )}
            {tool.id === 'codexhost' && tool.canLaunch && (
              <button
                onClick={() => void launchCodexHost()}
                disabled={updating !== null || !mutationsAllowed}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === 'codexhost-launch' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                {t('agents.cliTools.launch')}
              </button>
            )}
            {tool.installed && tool.runnable && !tool.canSelfUpdate && tool.manualHint && (
              <button
                onClick={() => void navigator.clipboard.writeText(tool.manualHint || '')}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                title={tool.manualHint}
              ><Copy className="h-3 w-3" />{t('agents.cliTools.manualUpdate')}</button>
            )}
            {!tool.installed && tool.canInstall && (
              <button
                onClick={() => void runAction(tool, 'install')}
                disabled={updating !== null}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
                {t('agents.cliTools.install')}
              </button>
            )}
            {!tool.installed && !tool.canInstall && tool.docsUrl && (
              <a
                href={tool.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
              >
                {t('agents.cliTools.installationGuide')}
              </a>
            )}
          </div>
        ))}
      </div>}

      {updateable.length > 1 && mutationsAllowed && (
        <button onClick={() => void updateAll()} disabled={updating !== null} className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <ArrowUpCircle className="h-3 w-3" />{t('agents.cliTools.updateAll', { count: updateable.length })}
        </button>
      )}

      {loadError && <p role="alert" className="mt-2 text-xs text-destructive">{t('agents.cliTools.loadFailed')}: {loadError}</p>}
      {message && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{message}</p>}
      {detail && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] text-muted-foreground">{detail}</pre>}
    </div>
  );
}
