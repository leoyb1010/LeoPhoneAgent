import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { apiClient } from '../../../utils/apiClient';
import type { Project } from '../../../types/app';
import {
  clearLegacyStarredProjectIds,
  readLegacyStarredProjectIds,
} from '../utils/utils';

type Args = { projects: Project[]; t: TFunction; onRefresh: () => Promise<void> | void };

export function useProjectStarToggle({ projects, t, onRefresh }: Args) {
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  const sequenceByProjectRef = useRef<Map<string, number>>(new Map());
  const migrationStartedRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (migrationStartedRef.current) return;
    const legacyIds = readLegacyStarredProjectIds();
    if (legacyIds.length === 0) return;
    migrationStartedRef.current = true;
    void (async () => {
      try {
        await apiClient.post('/api/projects/migrate-legacy-stars', { projectIds: legacyIds });
        await onRefreshRef.current();
      } catch (error) {
        console.error('[Sidebar] Failed to migrate legacy starred projects:', error);
      } finally {
        clearLegacyStarredProjectIds();
      }
    })();
  }, []);

  useEffect(() => {
    setOptimisticStarByProjectId((previous) => {
      if (previous.size === 0) return previous;
      const next = new Map(previous);
      let changed = false;
      for (const [projectId, optimisticValue] of previous) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project || Boolean(project.isStarred) === optimisticValue) {
          next.delete(projectId);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [projects]);

  const resolveProjectStarState = useCallback((projectId: string) => {
    if (optimisticStarByProjectId.has(projectId)) return Boolean(optimisticStarByProjectId.get(projectId));
    return projects.some((project) => project.projectId === projectId && Boolean(project.isStarred));
  }, [optimisticStarByProjectId, projects]);

  const toggleStarProject = useCallback((projectId: string) => {
    const previousValue = resolveProjectStarState(projectId);
    const optimisticValue = !previousValue;
    const sequence = (sequenceByProjectRef.current.get(projectId) ?? 0) + 1;
    sequenceByProjectRef.current.set(projectId, sequence);
    setOptimisticStarByProjectId((previous) => new Map(previous).set(projectId, optimisticValue));

    void (async () => {
      try {
        const payload = await apiClient.post<{ isStarred?: boolean }>(
          `/api/projects/${encodeURIComponent(projectId)}/toggle-star`,
        );
        if (sequenceByProjectRef.current.get(projectId) !== sequence) return;
        setOptimisticStarByProjectId((previous) => new Map(previous).set(projectId, Boolean(payload.isStarred)));
      } catch (error) {
        if (sequenceByProjectRef.current.get(projectId) !== sequence) return;
        setOptimisticStarByProjectId((previous) => new Map(previous).set(projectId, previousValue));
        console.error('[Sidebar] Failed to toggle project star:', error);
        alert(t('messages.updateProjectError'));
      }
    })();
  }, [resolveProjectStarState, t]);

  const projectsWithResolvedStarState = useMemo(() => projects.map((project) => {
    const resolved = resolveProjectStarState(project.projectId);
    return Boolean(project.isStarred) === resolved ? project : { ...project, isStarred: resolved };
  }), [projects, resolveProjectStarState]);

  return {
    toggleStarProject,
    isProjectStarred: resolveProjectStarState,
    projectsWithResolvedStarState,
  };
}
