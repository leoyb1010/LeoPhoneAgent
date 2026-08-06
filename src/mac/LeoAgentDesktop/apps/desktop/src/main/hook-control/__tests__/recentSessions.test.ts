import { describe, expect, it } from 'vitest';

import { minimiseRecentSessions } from '../recentSessions.js';

describe('minimiseRecentSessions', () => {
  it('returns aliases only and filters sessions outside the local allowlist', () => {
    const result = minimiseRecentSessions(
      [
        {
          id: 'project-session',
          title: 'Fix login',
          workingDir: '/workspace/project/.cindy-worktrees/a',
          workspaceKind: 'project',
          source: 'desktop',
          userSendAt: 20,
          updatedAt: 10,
        },
        {
          id: 'dialogue-session',
          title: 'Chat',
          workingDir: '/private/dialogues/1',
          workspaceKind: 'dialogue',
          source: 'telegram',
          userSendAt: null,
          updatedAt: 9,
        },
        {
          id: 'private-session',
          title: 'Do not expose',
          workingDir: '/private/other-account',
          workspaceKind: 'project',
          source: 'desktop',
          userSendAt: 8,
          updatedAt: 8,
        },
      ],
      { repo: '/workspace/project' },
    );
    expect(result).toEqual([
      { id: 'project-session', title: 'Fix login', workspace: 'repo', lastActiveAt: 20 },
      { id: 'dialogue-session', title: 'Chat', workspace: 'chat', lastActiveAt: 9 },
    ]);
    expect(JSON.stringify(result)).not.toContain('/workspace');
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('caps the wire response at twenty entries', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `s-${index}`,
      title: `Session ${index}`,
      workingDir: '/workspace/project',
      workspaceKind: 'project' as const,
      source: 'desktop',
      userSendAt: index,
      updatedAt: index,
    }));
    expect(minimiseRecentSessions(rows, { repo: '/workspace/project' })).toHaveLength(20);
  });

  it('normalizes empty titles and non-positive legacy timestamps to protocol-safe values', () => {
    expect(
      minimiseRecentSessions(
        [
          {
            id: 'legacy',
            title: '   ',
            workingDir: '/workspace/project',
            workspaceKind: 'project',
            source: 'desktop',
            userSendAt: 0,
            updatedAt: 0,
          },
        ],
        { repo: '/workspace/project' },
      ),
    ).toEqual([{ id: 'legacy', title: 'Untitled session', workspace: 'repo', lastActiveAt: 1 }]);
  });

  it('bounds persisted titles before serializing the session picker response', () => {
    const [session] = minimiseRecentSessions(
      [
        {
          id: 'long-title',
          title: 'x'.repeat(10_000),
          workingDir: '/workspace/project',
          workspaceKind: 'project',
          source: 'telegram',
          userSendAt: 10,
          updatedAt: 10,
        },
      ],
      { repo: '/workspace/project' },
    );
    expect(session?.title).toHaveLength(200);
  });

  it('does not expose hidden legacy or internal session sources', () => {
    expect(
      minimiseRecentSessions(
        [
          {
            id: 'hidden',
            title: 'Internal task',
            workingDir: '/workspace/project',
            workspaceKind: 'project',
            source: 'internal-worker',
            userSendAt: 12,
            updatedAt: 12,
          },
          {
            id: 'visible',
            title: 'Telegram task',
            workingDir: '/workspace/project',
            workspaceKind: 'project',
            source: 'telegram',
            userSendAt: 11,
            updatedAt: 11,
          },
        ],
        { repo: '/workspace/project' },
      ),
    ).toEqual([{ id: 'visible', title: 'Telegram task', workspace: 'repo', lastActiveAt: 11 }]);
  });
});
