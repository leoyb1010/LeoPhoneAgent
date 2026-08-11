import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { ArchivedProjectListItem, ArchivedSessionListItem, SidebarSearchMode } from '../types/types';

type ArchivedSessionsApiPayload = { data?: { sessions?: ArchivedSessionListItem[] } };
type ArchivedProjectsApiPayload = { data?: { projects?: ArchivedProjectListItem[] } };

export function useSidebarArchive(searchMode: SidebarSearchMode) {
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);

  const fetchArchivedSessions = useCallback(async () => {
    setIsArchivedSessionsLoading(true);
    try {
      const [projectsPayload, sessionsPayload] = await Promise.all([
        apiClient.get<ArchivedProjectsApiPayload>('/api/projects/archived'),
        apiClient.get<ArchivedSessionsApiPayload>('/api/providers/sessions/archived'),
      ]);
      const nextProjects = Array.isArray(projectsPayload.data?.projects) ? projectsPayload.data.projects : [];
      const projectIds = new Set(nextProjects.map((project) => project.projectId));
      const standaloneSessions = Array.isArray(sessionsPayload.data?.sessions)
        ? sessionsPayload.data.sessions.filter((session) => !session.projectId || !projectIds.has(session.projectId))
        : [];
      setArchivedProjects(nextProjects);
      setArchivedSessions(standaloneSessions);
    } catch (error) {
      console.error('[Sidebar] Failed to load archived sessions:', error);
    } finally {
      setIsArchivedSessionsLoading(false);
    }
  }, []);

  useEffect(() => { void fetchArchivedSessions(); }, [fetchArchivedSessions]);
  useEffect(() => {
    if (searchMode === 'archived') void fetchArchivedSessions();
  }, [fetchArchivedSessions, searchMode]);

  return {
    archivedProjects,
    archivedSessions,
    isArchivedSessionsLoading,
    fetchArchivedSessions,
  };
}
