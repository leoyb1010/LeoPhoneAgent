import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import type { ServerEvent } from '../contexts/WebSocketContext';
import type { LoadingProgress, Project, ProjectSession } from '../types/app';

import { getProjectSessions, upsertSessionIntoProject, type SessionUpsertedEvent } from './projectStateUtils';
import type { SessionActivityMap } from './useSessionProtection';

type Args = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  navigate: NavigateFunction;
  sessionId?: string;
  activeSessions: SessionActivityMap;
  selectedSession: ProjectSession | null;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setSelectedProject: Dispatch<SetStateAction<Project | null>>;
  setSelectedSession: Dispatch<SetStateAction<ProjectSession | null>>;
  markSessionAttention: (sessionId?: string | null) => void;
};

export function useProjectRealtimeEvents({
  subscribe,
  navigate,
  sessionId,
  activeSessions,
  selectedSession,
  setProjects,
  setSelectedProject,
  setSelectedSession,
  markSessionAttention,
}: Args) {
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;

  useEffect(() => {
    const handleEvent = (event: ServerEvent) => {
      if (event.kind === 'loading_progress') {
        if (loadingProgressTimeoutRef.current) clearTimeout(loadingProgressTimeoutRef.current);
        setLoadingProgress(event as unknown as LoadingProgress);
        if (event.phase === 'complete') {
          loadingProgressTimeoutRef.current = setTimeout(() => {
            setLoadingProgress(null);
            loadingProgressTimeoutRef.current = null;
          }, 500);
        }
        return;
      }

      const eventSessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
      const viewedSessionId = selectedSessionRef.current?.id ?? sessionId ?? null;
      if (
        eventSessionId
        && eventSessionId !== viewedSessionId
        && !['chat_subscribed', 'loading_progress', 'session_upserted', 'status', 'stream_end', 'permission_cancelled', 'websocket_reconnected'].includes(String(event.kind))
      ) markSessionAttention(eventSessionId);
      if (event.kind !== 'session_upserted') return;

      const upsert = event as SessionUpsertedEvent;
      if (!upsert.sessionId || !upsert.session) return;
      const currentSelectedSession = selectedSessionRef.current;
      if (currentSelectedSession && upsert.sessionId === currentSelectedSession.id && !activeSessionsRef.current.has(upsert.sessionId)) {
        setExternalMessageUpdate((previous) => previous + 1);
      } else {
        markSessionAttention(upsert.sessionId);
      }

      setProjects((previousProjects) => {
        const targetProjectId = upsert.project?.projectId;
        const existingProject = previousProjects.find((project) => targetProjectId
          ? project.projectId === targetProjectId
          : getProjectSessions(project).some((session) => session.id === upsert.sessionId));
        if (!existingProject) {
          if (!upsert.project) return previousProjects;
          const newProject = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0 },
          } as Project;
          return [...previousProjects, upsertSessionIntoProject(newProject, upsert)];
        }
        const updatedProject = upsertSessionIntoProject(existingProject, upsert);
        return updatedProject === existingProject
          ? previousProjects
          : previousProjects.map((project) => project.projectId === existingProject.projectId ? updatedProject : project);
      });

      setSelectedProject((previousProject) => {
        if (!previousProject) return previousProject;
        const matches = upsert.project
          ? previousProject.projectId === upsert.project.projectId
          : getProjectSessions(previousProject).some((session) => session.id === upsert.sessionId);
        if (!matches) return previousProject;
        const updated = upsertSessionIntoProject(previousProject, upsert);
        return updated === previousProject ? previousProject : updated;
      });

      const alias = typeof upsert.providerSessionId === 'string' && upsert.providerSessionId !== upsert.sessionId
        ? upsert.providerSessionId : null;
      if (!alias) return;
      const normalizedSession: ProjectSession = {
        ...upsert.session,
        id: upsert.sessionId,
        __provider: upsert.provider,
        __projectId: upsert.project?.projectId ?? currentSelectedSession?.__projectId,
      };
      setSelectedSession((previousSession) => previousSession?.id === alias
        ? { ...previousSession, ...normalizedSession }
        : previousSession);
      if (sessionId === alias) navigate(`/session/${upsert.sessionId}`);
    };
    return subscribe(handleEvent);
  }, [markSessionAttention, navigate, sessionId, setProjects, setSelectedProject, setSelectedSession, subscribe]);

  useEffect(() => () => {
    if (loadingProgressTimeoutRef.current) clearTimeout(loadingProgressTimeoutRef.current);
  }, []);

  return { loadingProgress, externalMessageUpdate };
}
