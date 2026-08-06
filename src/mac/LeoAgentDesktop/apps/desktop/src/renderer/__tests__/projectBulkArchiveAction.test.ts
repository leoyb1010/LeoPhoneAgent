import { describe, expect, it } from 'vitest';

import {
  projectBulkArchiveActionForStatus,
  selectProjectBulkArchiveCandidates,
  type ProjectBulkArchiveSession,
} from '../features/cc-agent/lib/projectBulkArchiveAction';

interface TestSession extends ProjectBulkArchiveSession {
  project: string;
}

const session = (
  id: string,
  status: TestSession['status'],
  project = 'project-a',
  pinnedAt: string | null = null,
): TestSession => ({ id, status, project, pinnedAt });

describe('project bulk archive action', () => {
  it.each([
    ['active', 'archive'],
    ['archived', 'unarchive'],
    ['all', 'archive'],
  ] as const)('maps the %s filter to %s', (status, action) => {
    expect(projectBulkArchiveActionForStatus(status)).toBe(action);
  });

  it('archives only eligible active sessions in the project', () => {
    const sessions = [
      session('active', 'active'),
      session('running', 'active'),
      session('pinned', 'active', 'project-a', '2026-07-17T00:00:00.000Z'),
      session('archived', 'archived'),
      session('other-project', 'active', 'project-b'),
    ];

    const result = selectProjectBulkArchiveCandidates(
      sessions,
      'archive',
      new Set(['running']),
      (item) => item.project === 'project-a',
    );

    expect(result.candidates.map((item) => item.id)).toEqual(['active']);
    expect(result.skippedPinned).toBe(1);
    expect(result.skippedRunning).toBe(1);
  });

  it('restores only archived sessions in the project', () => {
    const sessions = [
      session('active', 'active'),
      session('archived', 'archived'),
      session('legacy-pinned-archived', 'archived', 'project-a', '2026-07-17T00:00:00.000Z'),
      session('deleted-during-confirmation', 'deleted'),
      session('other-project', 'archived', 'project-b'),
    ];

    const result = selectProjectBulkArchiveCandidates(
      sessions,
      'unarchive',
      new Set(),
      (item) => item.project === 'project-a',
    );

    expect(result.candidates.map((item) => item.id)).toEqual([
      'archived',
      'legacy-pinned-archived',
    ]);
    expect(result.skippedPinned).toBe(0);
    expect(result.skippedRunning).toBe(0);
  });
});
