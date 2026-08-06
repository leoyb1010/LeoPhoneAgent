import type { FilterStatus } from '../hooks/useSidebarFilter';

export type ProjectBulkArchiveAction = 'archive' | 'unarchive';

export interface ProjectBulkArchiveSession {
  id: string;
  status: 'active' | 'archived' | 'deleted';
  pinnedAt: string | null;
}

export interface ProjectBulkArchiveCandidates<T extends ProjectBulkArchiveSession> {
  candidates: T[];
  skippedPinned: number;
  skippedRunning: number;
}

/**
 * The archived bucket is the only view whose project-level action restores
 * sessions. The active and all buckets keep the existing archive-active-only
 * behavior so the all view never toggles already archived sessions.
 */
export function projectBulkArchiveActionForStatus(status: FilterStatus): ProjectBulkArchiveAction {
  return status === 'archived' ? 'unarchive' : 'archive';
}

/**
 * Select the sessions affected by a project-level archive action.
 *
 * Archiving preserves the existing safety rules for running and pinned
 * sessions. Restoring only targets archived sessions; archived sessions have
 * no running query to stop and restoring them does not clear pin metadata.
 */
export function selectProjectBulkArchiveCandidates<T extends ProjectBulkArchiveSession>(
  sessions: readonly T[],
  action: ProjectBulkArchiveAction,
  runningSessionIds: ReadonlySet<string>,
  belongsToProject: (session: T) => boolean,
): ProjectBulkArchiveCandidates<T> {
  const sourceStatus = action === 'archive' ? 'active' : 'archived';
  const inProject = sessions.filter(
    (session) => belongsToProject(session) && session.status === sourceStatus,
  );

  if (action === 'unarchive') {
    return {
      candidates: inProject,
      skippedPinned: 0,
      skippedRunning: 0,
    };
  }

  return {
    candidates: inProject.filter(
      (session) => !runningSessionIds.has(session.id) && !session.pinnedAt,
    ),
    skippedPinned: inProject.filter((session) => Boolean(session.pinnedAt)).length,
    skippedRunning: inProject.filter(
      (session) => runningSessionIds.has(session.id) && !session.pinnedAt,
    ).length,
  };
}
