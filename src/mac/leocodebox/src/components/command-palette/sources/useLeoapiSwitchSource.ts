import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

export type LeoapiSwitchNode = {
  id: string;
  name: string;
  target: string;
  baseUrl: string;
  isActive: boolean;
  latencyMs: number | null;
};

type SwitchStatusResponse = {
  success: boolean;
  activeByTarget?: Record<string, string>;
  providers?: Array<{
    id: string;
    name: string;
    target: string;
    baseUrl?: string;
    endpointStats?: Record<string, { latencyMs?: number } | undefined>;
  }>;
};

type TestResponse = { success: boolean; ok?: boolean; latencyMs?: number; message?: string };
type ApplyResponse = { success: boolean; provider?: { name?: string }; error?: string };

/**
 * ⌘K Leoapi lane: exactly two verbs — apply a node and test its
 * connectivity. Provider management stays in the Leoapi page.
 */
export function useLeoapiSwitchSource(enabled: boolean) {
  const [nodes, setNodes] = useState<LeoapiSwitchNode[]>([]);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await apiClient.get<SwitchStatusResponse>('/api/leocodebox/switch/status');
      if (!status?.success) return;
      const active = new Set(Object.values(status.activeByTarget || {}));
      setNodes((status.providers || []).map((provider) => {
        const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
        const stats = baseUrl ? provider.endpointStats?.[baseUrl] : undefined;
        return {
          id: provider.id,
          name: provider.name,
          target: provider.target,
          baseUrl,
          isActive: active.has(provider.id),
          latencyMs: typeof stats?.latencyMs === 'number' ? stats.latencyMs : null,
        };
      }));
    } catch {
      setNodes([]);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      setLastResult(null);
      void refresh();
    }
  }, [enabled, refresh]);

  const apply = useCallback(async (node: LeoapiSwitchNode): Promise<string> => {
    setBusyNodeId(node.id);
    try {
      const result = await apiClient.post<ApplyResponse>(`/api/leocodebox/switch/providers/${node.id}/apply`);
      if (!result?.success) throw new Error(result?.error || 'apply failed');
      await refresh();
      return node.name;
    } finally {
      setBusyNodeId(null);
    }
  }, [refresh]);

  const test = useCallback(async (node: LeoapiSwitchNode) => {
    setBusyNodeId(node.id);
    setLastResult(null);
    try {
      const result = await apiClient.post<TestResponse>(`/api/leocodebox/switch/providers/${node.id}/test`);
      const summary = result?.ok
        ? `${node.name} · ${typeof result.latencyMs === 'number' ? `${result.latencyMs}ms` : 'ok'}`
        : `${node.name} · ${result?.message || 'failed'}`;
      setLastResult(summary);
      await refresh();
      return summary;
    } catch (error) {
      const summary = `${node.name} · ${error instanceof Error ? error.message : 'failed'}`;
      setLastResult(summary);
      return summary;
    } finally {
      setBusyNodeId(null);
    }
  }, [refresh]);

  return { nodes, busyNodeId, lastResult, apply, test };
}
