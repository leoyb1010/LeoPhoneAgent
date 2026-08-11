import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import { PROVIDER_DEFAULT_MODEL } from '../constants';
import type { AgentProfile, AgentProfileDraft, ApiResponse } from '../types';

const BASE = '/api/agent-profiles';

type ProfilesState = {
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (draft: AgentProfileDraft) => Promise<AgentProfile | null>;
  update: (id: string, draft: AgentProfileDraft) => Promise<AgentProfile | null>;
  remove: (id: string) => Promise<boolean>;
  launch: (profile: AgentProfile) => void;
  exportAll: () => void;
  importFile: (file: File) => Promise<number>;
};

const errorText = (error: unknown, fallback: string): string => (
  error instanceof Error ? error.message : fallback
);

/**
 * Manages the agent-profile library plus the "launch" action. Launching a
 * profile never talks to the server — it dispatches the same composer
 * preference/draft events the command palette already uses, so a profile is
 * applied to a brand-new conversation without any run-scoped backend concept.
 */
export function useAgentProfiles(active: boolean, onAfterLaunch?: () => void): ProfilesState {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiClient
      .get<ApiResponse<{ profiles: AgentProfile[] }>>(BASE)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) throw new Error(res.error || 'Failed to load profiles');
        setProfiles(res.data?.profiles ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, 'Failed to load profiles'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const create = useCallback(async (draft: AgentProfileDraft) => {
    try {
      const res = await apiClient.post<ApiResponse<{ profile: AgentProfile }>>(BASE, draft);
      if (!res.success || !res.data?.profile) throw new Error(res.error || 'Create failed');
      reload();
      return res.data.profile;
    } catch (err) {
      setError(errorText(err, 'Create failed'));
      return null;
    }
  }, [reload]);

  const update = useCallback(async (id: string, draft: AgentProfileDraft) => {
    try {
      const res = await apiClient.put<ApiResponse<{ profile: AgentProfile }>>(`${BASE}/${encodeURIComponent(id)}`, draft);
      if (!res.success || !res.data?.profile) throw new Error(res.error || 'Update failed');
      reload();
      return res.data.profile;
    } catch (err) {
      setError(errorText(err, 'Update failed'));
      return null;
    }
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await apiClient.delete<ApiResponse<{ removed: boolean }>>(`${BASE}/${encodeURIComponent(id)}`);
      if (!res.success) throw new Error(res.error || 'Delete failed');
      reload();
      return true;
    } catch (err) {
      setError(errorText(err, 'Delete failed'));
      return false;
    }
  }, [reload]);

  // Apply the profile to a fresh conversation via the composer's existing event bus.
  const launch = useCallback((profile: AgentProfile) => {
    window.dispatchEvent(new CustomEvent('leocodebox-preferences:changed', {
      detail: {
        defaultProvider: profile.provider,
        // Always send a model: a pinned one, else the provider default — so launch
        // resets to the promised default instead of inheriting the last-active model.
        defaultModel: profile.model.trim() || PROVIDER_DEFAULT_MODEL[profile.provider],
        permissionMode: profile.permissionMode,
        effort: profile.effort,
      },
    }));
    window.dispatchEvent(new CustomEvent('leocodebox:launch-new-chat'));
    if (profile.openingPrompt.trim()) {
      window.dispatchEvent(new CustomEvent('leocodebox:handoff-draft', {
        detail: { text: profile.openingPrompt },
      }));
    }
    onAfterLaunch?.();
  }, [onAfterLaunch]);

  const exportAll = useCallback(() => {
    const doc = { version: 1, kind: 'leocodebox-agent-profiles', profiles };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'agent-profiles.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [profiles]);

  const importFile = useCallback(async (file: File): Promise<number> => {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('文件不是有效的 JSON');
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { profiles?: unknown })?.profiles)
        ? (parsed as { profiles: unknown[] }).profiles
        : null;
    if (!list) throw new Error('未找到可导入的档案列表');
    const res = await apiClient.post<ApiResponse<{ count: number }>>(`${BASE}/import`, { profiles: list });
    if (!res.success) throw new Error(res.error || '导入失败');
    reload();
    return res.data?.count ?? 0;
  }, [reload]);

  return { profiles, loading, error, reload, create, update, remove, launch, exportAll, importFile };
}
