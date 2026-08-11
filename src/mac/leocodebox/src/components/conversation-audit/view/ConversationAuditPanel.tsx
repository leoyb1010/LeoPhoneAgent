import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Filter, Loader2, Pause, Play, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../utils/apiClient';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import { Button } from '../../../shared/view/ui';

import { mapWithConcurrency, matchesCategory, messageText } from './auditUtils';
import type { AuditCategory, ReplayMessage } from './auditUtils';

type AuditSession = ProjectSession & {
  projectId: string;
  projectName: string;
  resolvedProvider: LLMProvider;
  timestamp: string | null;
};
type UsageSummaryRow = { day: string; provider: string; model: string | null; sessionCount: number; inputTokens: number; outputTokens: number; cacheTokens: number; costUsd: number };
type ModelPrices = Record<string, { input: number; output: number }>;

type ReplayPayload = {
  messages: ReplayMessage[];
  total?: number;
  hasMore?: boolean;
  tokenUsage?: unknown;
};

const PROVIDERS: Array<'all' | LLMProvider> = ['all', 'claude', 'cursor', 'codex', 'opencode'];

function resolveTimestamp(session: ProjectSession): string | null {
  const value = session.lastActivity || session.updated_at || session.createdAt || session.created_at;
  return typeof value === 'string' && value ? value : null;
}

function resolveProvider(session: ProjectSession): LLMProvider {
  const provider = session.__provider || session.provider;
  return PROVIDERS.includes(provider as LLMProvider) ? provider as LLMProvider : 'claude';
}

function sessionLabel(session: ProjectSession): string {
  return String(session.title || session.summary || session.name || session.id);
}

async function loadProjectSessions(project: Project, signal?: AbortSignal): Promise<AuditSession[]> {
  const collected: ProjectSession[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await apiClient.get<{ sessions?: ProjectSession[]; sessionMeta?: { total?: number; hasMore?: boolean } }>(
      `/api/projects/${encodeURIComponent(project.projectId)}/sessions`,
      { limit, offset },
      signal,
    );
    const sessions = Array.isArray(page.sessions) ? page.sessions : [];
    collected.push(...sessions);
    offset += sessions.length;
    const total = Number(page.sessionMeta?.total || 0);
    if (sessions.length === 0 || page.sessionMeta?.hasMore === false || (total > 0 && offset >= total) || sessions.length < limit) {
      break;
    }
  }

  return collected.map((session) => ({
    ...session,
    projectId: project.projectId,
    projectName: project.displayName,
    resolvedProvider: resolveProvider(session),
    timestamp: resolveTimestamp(session),
  }));
}

export default function ConversationAuditPanel() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<AuditSession[]>([]);
  const [usageRows, setUsageRows] = useState<UsageSummaryRow[]>([]);
  const [selectedSession, setSelectedSession] = useState<AuditSession | null>(null);
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [projectFilter, setProjectFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState<'all' | LLMProvider>('all');
  const [category, setCategory] = useState<AuditCategory>('all');
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPricing, setShowPricing] = useState(false);
  const [priceText, setPriceText] = useState('{}');
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const replayAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const [nextProjects, usage, pricing] = await Promise.all([
        apiClient.get<Project[]>('/api/projects'),
        apiClient.get<{ rows?: UsageSummaryRow[] }>('/api/usage/summary'),
        apiClient.get<{ prices?: ModelPrices }>('/api/usage/prices'),
      ]);
      const sessionGroups = await mapWithConcurrency(
        nextProjects,
        4,
        (project) => loadProjectSessions(project, controller.signal),
      );
      setProjects(nextProjects);
      setUsageRows(Array.isArray(usage.rows) ? usage.rows : []);
      setPriceText(JSON.stringify(pricing.prices || {}, null, 2));
      setSessions(sessionGroups.flat().sort((left, right) => (
        Date.parse(right.timestamp || '') - Date.parse(left.timestamp || '')
      )));
    } catch (caughtError) {
      if (!(caughtError instanceof Error && caughtError.name === 'AbortError')) {
        setError(caughtError instanceof Error ? caughtError.message : t('audit.loadError'));
      }
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAbortRef.current?.abort();
      replayAbortRef.current?.abort();
    };
  }, [refresh]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
    return sessions.filter((session) => {
      const timestamp = session.timestamp ? Date.parse(session.timestamp) : 0;
      return (projectFilter === 'all' || session.projectId === projectFilter)
        && (providerFilter === 'all' || session.resolvedProvider === providerFilter)
        && timestamp >= fromTime
        && timestamp <= toTime
        && (!normalizedQuery || sessionLabel(session).toLowerCase().includes(normalizedQuery));
    });
  }, [dateFrom, dateTo, projectFilter, providerFilter, query, sessions]);

  const loadReplay = useCallback(async (session: AuditSession) => {
    replayAbortRef.current?.abort();
    const controller = new AbortController();
    replayAbortRef.current = controller;
    setSelectedSession(session);
    setReplayLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{ data?: ReplayPayload } & ReplayPayload>(
        `/api/providers/sessions/${encodeURIComponent(session.id)}/messages`,
        { limit: 1000, offset: 0 },
        controller.signal,
      );
      const payload = response.data || response;
      const sequencedMessages = (payload.messages || [])
        .map((message, index) => ({ ...message, seq: typeof message.seq === 'number' ? message.seq : index + 1 }))
        .sort((left, right) => Number(left.seq) - Number(right.seq));
      setReplay({ ...payload, messages: sequencedMessages });
      setReplayCursor(null);
      setReplayPlaying(false);
    } catch (caughtError) {
      if (!(caughtError instanceof Error && caughtError.name === 'AbortError')) {
        setReplay(null);
        setError(caughtError instanceof Error ? caughtError.message : t('audit.replayError'));
      }
    } finally {
      if (replayAbortRef.current === controller) {
        replayAbortRef.current = null;
        setReplayLoading(false);
      }
    }
  }, [t]);

  const visibleMessages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (replay?.messages || []).filter((message) => (
      matchesCategory(message, category)
      && (!normalizedQuery || messageText(message).toLowerCase().includes(normalizedQuery))
    ));
  }, [category, query, replay?.messages]);

  const usageTotals = useMemo(() => usageRows.reduce((totals, row) => ({
    sessions: totals.sessions + Number(row.sessionCount || 0),
    tokens: totals.tokens + Number(row.inputTokens || 0) + Number(row.outputTokens || 0) + Number(row.cacheTokens || 0),
    costUsd: totals.costUsd + Number(row.costUsd || 0),
  }), { sessions: 0, tokens: 0, costUsd: 0 }), [usageRows]);

  const usageByDay = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of usageRows) totals.set(row.day, (totals.get(row.day) || 0) + Number(row.costUsd || 0));
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  }, [usageRows]);

  useEffect(() => {
    if (!replayPlaying || !replay?.messages.length) return undefined;
    const timer = window.setInterval(() => {
      setReplayCursor((current) => {
        const next = (current ?? 0) + 1;
        if (next >= replay.messages.length) {
          setReplayPlaying(false);
          return replay.messages.length;
        }
        return next;
      });
    }, Math.max(100, 800 / replaySpeed));
    return () => window.clearInterval(timer);
  }, [replay?.messages.length, replayPlaying, replaySpeed]);

  const savePrices = useCallback(async () => {
    try {
      const prices = JSON.parse(priceText) as ModelPrices;
      const result = await apiClient.put<{ prices?: ModelPrices }>('/api/usage/prices', { prices });
      setPriceText(JSON.stringify(result.prices || prices, null, 2));
      setShowPricing(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Invalid pricing JSON');
    }
  }, [priceText]);

  const exportAudit = useCallback(() => {
    const payload = selectedSession && replay
      ? { exportedAt: new Date().toISOString(), session: selectedSession, replay, filters: { category, query } }
      : { exportedAt: new Date().toISOString(), sessions: filteredSessions, filters: { projectFilter, providerFilter, dateFrom, dateTo, query } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedSession ? `session-audit-${selectedSession.id}.json` : 'session-audit.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [category, dateFrom, dateTo, filteredSessions, projectFilter, providerFilter, query, replay, selectedSession]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="mr-auto">
          <h2 className="text-sm font-semibold text-foreground">{t('audit.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('audit.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('audit.refresh')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowPricing((value) => !value)}>
          <Settings2 className="h-4 w-4" /> Prices
        </Button>
        <Button variant="outline" size="sm" onClick={exportAudit} disabled={filteredSessions.length === 0 && !replay}>
          <Download className="h-4 w-4" />
          {t('audit.export')}
        </Button>
      </header>

      <div className="grid grid-cols-3 gap-2 border-b border-border px-3 py-2">
        <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-[10px] uppercase text-muted-foreground">Sessions</div><div className="text-sm font-semibold">{usageTotals.sessions.toLocaleString()}</div></div>
        <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-[10px] uppercase text-muted-foreground">Tokens</div><div className="text-sm font-semibold">{usageTotals.tokens.toLocaleString()}</div></div>
        <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-[10px] uppercase text-muted-foreground">Estimated cost</div><div className="text-sm font-semibold">${usageTotals.costUsd.toFixed(2)}</div></div>
      </div>

      {usageByDay.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">14-day cost trend</div>
          <div className="flex h-12 items-end gap-1" aria-label="Daily cost trend">
            {usageByDay.map(([day, cost]) => {
              const max = Math.max(...usageByDay.map(([, value]) => value), 0.000001);
              return <div key={day} className="min-w-0 flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(4, (cost / max) * 100)}%` }} title={`${day}: $${cost.toFixed(4)}`} />;
            })}
          </div>
        </div>
      )}
      {showPricing && (
        <div className="border-b border-border p-3">
          <label className="mb-1 block text-xs font-medium">Model prices per million tokens (JSON)</label>
          <textarea className="h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" value={priceText} onChange={(event) => setPriceText(event.target.value)} />
          <div className="mt-2 flex justify-end"><Button size="sm" onClick={() => void savePrices()}>Save prices</Button></div>
        </div>
      )}

      <div className="grid gap-2 border-b border-border p-3 md:grid-cols-6">
        <label className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('audit.search')} aria-label={t('audit.search')} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm" />
        </label>
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label={t('audit.project')} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="all">{t('audit.allProjects')}</option>
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}
        </select>
        <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value as 'all' | LLMProvider)} aria-label={t('audit.provider')} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider === 'all' ? t('audit.allProviders') : provider}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label={t('audit.dateFrom')} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
        <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label={t('audit.dateTo')} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
      </div>

      {error && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      <div className="grid min-h-0 flex-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-border p-2" aria-label={t('audit.sessions')}>
          {loading && sessions.length === 0 ? <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
          {!loading && filteredSessions.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">{t('audit.noSessions')}</p> : null}
          {filteredSessions.map((session) => (
            <button key={`${session.projectId}:${session.id}`} type="button" onClick={() => void loadReplay(session)} aria-pressed={selectedSession?.id === session.id} className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selectedSession?.id === session.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'}`}>
              <div className="truncate text-sm font-medium">{sessionLabel(session)}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{session.projectName}</span><span className="uppercase">{session.resolvedProvider}</span></div>
              {session.timestamp && <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={session.timestamp}>{new Date(session.timestamp).toLocaleString()}</time>}
            </button>
          ))}
        </aside>

        <main className="min-h-0 overflow-y-auto p-4">
          {!selectedSession ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Filter className="mr-2 h-4 w-4" />{t('audit.selectSession')}</div> : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="mr-auto text-sm font-semibold">{sessionLabel(selectedSession)}</h3>
                <select value={category} onChange={(event) => setCategory(event.target.value as AuditCategory)} aria-label={t('audit.eventType')} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
                  <option value="all">{t('audit.allEvents')}</option><option value="tool">{t('audit.toolCalls')}</option><option value="error">{t('audit.errors')}</option><option value="permission">{t('audit.permissions')}</option>
                </select>
              </div>
              {replay && replay.messages.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                  <Button size="sm" variant="outline" onClick={() => { setReplayCursor((value) => value ?? 0); setReplayPlaying((value) => !value); }}>
                    {replayPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {replayPlaying ? 'Pause' : 'Replay'}
                  </Button>
                  <input className="min-w-32 flex-1" type="range" min="0" max={replay.messages.length} value={replayCursor ?? replay.messages.length} onChange={(event) => { setReplayPlaying(false); setReplayCursor(Number(event.target.value)); }} aria-label="Timeline position" />
                  <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={replaySpeed} onChange={(event) => setReplaySpeed(Number(event.target.value))} aria-label="Replay speed">
                    <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
                  </select>
                  <span className="text-xs text-muted-foreground">{replayCursor ?? replay.messages.length}/{replay.messages.length}</span>
                </div>
              )}
              {replay?.tokenUsage !== undefined && <pre className="mb-3 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs"><strong>{t('audit.tokenUsage')}</strong>{'\n'}{JSON.stringify(replay.tokenUsage, null, 2)}</pre>}
              {replayLoading ? <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin" /></div> : visibleMessages.slice(0, replayCursor ?? visibleMessages.length).map((message, index) => (
                <article key={String(message.id || message.uuid || index)} className="relative mb-2 ml-2 rounded-md border border-border p-3 before:absolute before:-left-[9px] before:top-4 before:h-2 before:w-2 before:rounded-full before:bg-primary after:absolute after:-left-[6px] after:top-6 after:h-[calc(100%+0.5rem)] after:w-px after:bg-border last:after:hidden">
                  <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
                    <span>{String(message.role || message.type || t('audit.event'))}</span>
                    {typeof message.seq === 'number' && <span className="font-mono font-normal normal-case">seq {message.seq}</span>}
                    {typeof message.timestamp === 'string' && <time className="ml-auto font-normal normal-case">{new Date(message.timestamp).toLocaleTimeString()}</time>}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">{messageText(message)}</pre>
                </article>
              ))}
              {!replayLoading && replay && visibleMessages.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">{t('audit.noEvents')}</p>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
