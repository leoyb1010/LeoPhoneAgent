import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '../utils/apiClient';
import { startVisibleInterval } from '../utils/visibilityInterval';
import type {
  ClaudeQuotaEstimate,
  CliToolStatus,
  CliToolsStatusPayload,
  MissionCard,
  ProviderAuthStatus,
  UsageSummaryRow,
} from '../components/dashboard/dashboardTypes';

// Providers that expose an auth/status endpoint (parseProvider accepts these).
const AUTH_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'grok'] as const;

const REFRESH_INTERVAL_MS = 30_000;

type Slice<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

function idleSlice<T>(): Slice<T> {
  return { data: null, loading: true, error: null };
}

export type ProjectSummary = {
  projectId: string;
  displayName: string;
  isStarred?: boolean;
  providerCounts?: Record<string, number>;
};

export type DashboardData = {
  cliTools: Slice<CliToolStatus[]>;
  providerAuth: Slice<Record<string, ProviderAuthStatus>>;
  usage: Slice<UsageSummaryRow[]>;
  missions: Slice<MissionCard[]>;
  authUser: Slice<{ username: string }>;
  quota: Slice<ClaudeQuotaEstimate>;
  projects: Slice<ProjectSummary[]>;
  refresh: () => void;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '加载失败';
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Aggregates every read-only endpoint the dashboard needs. Each concern is an
 * independent slice with its own loading/error so one slow CLI probe never
 * blanks the whole page. Polls on a 30s visible interval; running sessions
 * stay live separately through the WebSocket (RunningSessionsCard).
 */
export function useDashboardData(): DashboardData {
  const [cliTools, setCliTools] = useState<Slice<CliToolStatus[]>>(idleSlice);
  const [providerAuth, setProviderAuth] = useState<Slice<Record<string, ProviderAuthStatus>>>(idleSlice);
  const [usage, setUsage] = useState<Slice<UsageSummaryRow[]>>(idleSlice);
  const [missions, setMissions] = useState<Slice<MissionCard[]>>(idleSlice);
  const [authUser, setAuthUser] = useState<Slice<{ username: string }>>(idleSlice);
  const [quota, setQuota] = useState<Slice<ClaudeQuotaEstimate>>(idleSlice);
  const [projects, setProjects] = useState<Slice<ProjectSummary[]>>(idleSlice);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCliTools = useCallback(async () => {
    try {
      const payload = await apiClient.get<CliToolsStatusPayload>('/api/leocodebox/cli/status');
      if (!mountedRef.current) return;
      setCliTools({ data: Array.isArray(payload.tools) ? payload.tools : [], loading: false, error: null });
    } catch (error) {
      if (!mountedRef.current) return;
      setCliTools((prev) => ({ ...prev, loading: false, error: toErrorMessage(error) }));
    }
  }, []);

  const loadProviderAuth = useCallback(async () => {
    const results = await Promise.allSettled(
      AUTH_PROVIDERS.map(async (provider) => {
        const payload = await apiClient.get<{ success?: boolean; data?: ProviderAuthStatus } & ProviderAuthStatus>(
          `/api/providers/${provider}/auth/status`,
        );
        const status = (payload.data ?? payload) as ProviderAuthStatus;
        return [provider, { ...status, provider }] as const;
      }),
    );
    if (!mountedRef.current) return;
    const map: Record<string, ProviderAuthStatus> = {};
    let firstError: string | null = null;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        map[result.value[0]] = result.value[1];
      } else {
        firstError = firstError ?? toErrorMessage(result.reason);
        map[AUTH_PROVIDERS[index]] = {
          provider: AUTH_PROVIDERS[index],
          installed: false,
          authenticated: false,
          error: toErrorMessage(result.reason),
        };
      }
    });
    setProviderAuth({ data: map, loading: false, error: firstError });
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 6);
      const payload = await apiClient.get<{ success?: boolean; rows?: UsageSummaryRow[] }>(
        '/api/usage/summary',
        { from: isoDay(from), to: isoDay(to) },
      );
      if (!mountedRef.current) return;
      setUsage({ data: Array.isArray(payload.rows) ? payload.rows : [], loading: false, error: null });
    } catch (error) {
      if (!mountedRef.current) return;
      setUsage((prev) => ({ ...prev, loading: false, error: toErrorMessage(error) }));
    }
  }, []);

  const loadMissions = useCallback(async () => {
    try {
      const payload = await apiClient.get<{ success?: boolean; cards?: MissionCard[] }>('/api/leocodebox/missions');
      if (!mountedRef.current) return;
      setMissions({ data: Array.isArray(payload.cards) ? payload.cards : [], loading: false, error: null });
    } catch (error) {
      if (!mountedRef.current) return;
      setMissions((prev) => ({ ...prev, loading: false, error: toErrorMessage(error) }));
    }
  }, []);

  const loadAuthUser = useCallback(async () => {
    try {
      const payload = await apiClient.get<{ user?: { username?: string } }>('/api/auth/user');
      if (!mountedRef.current) return;
      const username = payload.user?.username || 'local-user';
      setAuthUser({ data: { username }, loading: false, error: null });
    } catch {
      if (!mountedRef.current) return;
      // Local-only desktop auth may not expose /auth/user; degrade gracefully.
      setAuthUser({ data: { username: 'local-user' }, loading: false, error: null });
    }
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const payload = await apiClient.get<{ success?: boolean; quota?: ClaudeQuotaEstimate }>('/api/usage/claude-quota');
      if (!mountedRef.current) return;
      setQuota({ data: payload.quota ?? null, loading: false, error: null });
    } catch (error) {
      if (!mountedRef.current) return;
      // Quota is optional — a failure just hides the rings, not the page.
      setQuota({ data: null, loading: false, error: toErrorMessage(error) });
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const payload = await apiClient.get<ProjectSummary[]>('/api/projects');
      if (!mountedRef.current) return;
      setProjects({ data: Array.isArray(payload) ? payload : [], loading: false, error: null });
    } catch (error) {
      if (!mountedRef.current) return;
      setProjects((prev) => ({ ...prev, loading: false, error: toErrorMessage(error) }));
    }
  }, []);

  // No running-sessions slice here on purpose: RunningSessionsCard owns that
  // data and polls /sessions/running every 5s itself. This hook used to fetch
  // the same endpoint every 30s into a slice nothing ever read.
  const loadAll = useCallback(() => {
    void loadCliTools();
    void loadProviderAuth();
    void loadUsage();
    void loadMissions();
    void loadAuthUser();
    void loadQuota();
    void loadProjects();
  }, [loadCliTools, loadProviderAuth, loadUsage, loadMissions, loadAuthUser, loadQuota, loadProjects]);

  useEffect(() => {
    loadAll();
    const stop = startVisibleInterval(loadAll, REFRESH_INTERVAL_MS);
    return stop;
  }, [loadAll]);

  return {
    cliTools,
    providerAuth,
    usage,
    missions,
    authUser,
    quota,
    projects,
    refresh: loadAll,
  };
}
