import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import { MCP_PROVIDER_NAMES } from '../constants';
import type { ApiResponse, McpProvider, ProviderMcpServer, UpsertProviderMcpServerPayload } from '../types';
import { aggregateInstalledMcp, type McpOverviewRow } from '../utils/mcpFormatting';

import { fetchProviderScopeServers } from './useMcpServers';

const OVERVIEW_CACHE_TTL_MS = 30_000;
const PROVIDERS = Object.keys(MCP_PROVIDER_NAMES) as McpProvider[];

type OverviewCache = { rows: McpOverviewRow[]; errors: string[]; updatedAt: number };
let overviewCache: OverviewCache | null = null;

export const mcpChipKey = (name: string, provider: McpProvider): string => `${name}::${provider}`;

const toUpsertPayload = (server: ProviderMcpServer): UpsertProviderMcpServerPayload => ({
  name: server.name,
  scope: 'user',
  transport: server.transport,
  command: server.command,
  args: server.args,
  env: server.env,
  cwd: server.cwd,
  url: server.url,
  headers: server.headers,
  envVars: server.envVars,
  bearerTokenEnvVar: server.bearerTokenEnvVar,
  envHttpHeaders: server.envHttpHeaders,
});

type McpOverviewState = {
  rows: McpOverviewRow[];
  loading: boolean;
  errors: string[];
  reload: () => void;
  pending: string | null;
  writeError: string | null;
  installTo: (row: McpOverviewRow, provider: McpProvider) => Promise<void>;
  removeFrom: (row: McpOverviewRow, provider: McpProvider) => Promise<void>;
};

/**
 * Read-only aggregation of user-scope MCP servers across every supported CLI.
 * Each provider is queried independently (allSettled) so one unreadable CLI
 * config degrades to a soft error instead of blanking the whole panel. A short
 * module cache keeps repeated Agents-tab switches from refetching.
 */
export function useMcpOverview(active: boolean): McpOverviewState {
  const [rows, setRows] = useState<McpOverviewRow[]>(() => overviewCache?.rows ?? []);
  const [errors, setErrors] = useState<string[]>(() => overviewCache?.errors ?? []);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    if (reloadKey === 0 && overviewCache && Date.now() - overviewCache.updatedAt < OVERVIEW_CACHE_TTL_MS) {
      setRows(overviewCache.rows);
      setErrors(overviewCache.errors);
      return undefined;
    }

    setLoading(true);
    void Promise.allSettled(PROVIDERS.map((provider) => fetchProviderScopeServers(provider, 'user'))).then((settled) => {
      if (cancelled) return;
      const perProvider: Partial<Record<McpProvider, ProviderMcpServer[]>> = {};
      const nextErrors: string[] = [];
      settled.forEach((result, index) => {
        const provider = PROVIDERS[index];
        if (result.status === 'fulfilled') {
          perProvider[provider] = result.value;
        } else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          nextErrors.push(`${MCP_PROVIDER_NAMES[provider]}: ${message}`);
        }
      });
      const nextRows = aggregateInstalledMcp(perProvider);
      overviewCache = { rows: nextRows, errors: nextErrors, updatedAt: Date.now() };
      setRows(nextRows);
      setErrors(nextErrors);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [active, reloadKey]);

  const reload = useCallback(() => {
    overviewCache = null;
    setReloadKey((key) => key + 1);
  }, []);

  // Copy an installed server's config into another CLI (writes go through the
  // server's transactional backup, so a bad write can't corrupt the config).
  const installTo = useCallback(async (row: McpOverviewRow, provider: McpProvider) => {
    const source = row.configs[provider] ?? Object.values(row.configs).find(Boolean);
    if (!source) return;
    setPending(mcpChipKey(row.name, provider));
    setWriteError(null);
    try {
      const res = await apiClient.post<ApiResponse<unknown>>(
        `/api/providers/${provider}/mcp/servers`,
        toUpsertPayload(source),
      );
      if (!res.success) throw new Error('Install failed');
      reload();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : 'Install failed');
    } finally {
      setPending(null);
    }
  }, [reload]);

  const removeFrom = useCallback(async (row: McpOverviewRow, provider: McpProvider) => {
    setPending(mcpChipKey(row.name, provider));
    setWriteError(null);
    try {
      const res = await apiClient.deleteQuery<ApiResponse<unknown>>(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(row.name)}`,
        { scope: 'user' },
      );
      if (!res.success) throw new Error('Remove failed');
      reload();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : 'Remove failed');
    } finally {
      setPending(null);
    }
  }, [reload]);

  return { rows, loading, errors, reload, pending, writeError, installTo, removeFrom };
}
