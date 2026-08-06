import { describe, expect, it } from 'vitest';
import { sessionWorkspaceTitle, sessionWorktreeLabel } from '../sessionIdentity.js';

describe('sessionWorkspaceTitle', () => {
  it('returns Dialogue when there is no working dir', () => {
    expect(sessionWorkspaceTitle({ workingDir: null })).toBe('Dialogue');
  });

  it('returns the basename of the working dir on both separators', () => {
    expect(sessionWorkspaceTitle({ workingDir: '/Users/me/project' })).toBe('project');
    expect(sessionWorkspaceTitle({ workingDir: 'C:\\Users\\me\\project' })).toBe('project');
  });

  it('ignores trailing separators', () => {
    expect(sessionWorkspaceTitle({ workingDir: '/Users/me/project///' })).toBe('project');
    expect(sessionWorkspaceTitle({ workingDir: 'C:\\Users\\me\\project\\' })).toBe('project');
  });

  it('falls back to the raw value when it is only separators', () => {
    expect(sessionWorkspaceTitle({ workingDir: '///' })).toBe('///');
  });
});

describe('sessionWorktreeLabel', () => {
  it('labels a worktree by its basename, ignoring a trailing slash', () => {
    expect(sessionWorktreeLabel({ worktreePath: '/repo/.worktrees/feature-x/' })).toBe('Worktree feature-x');
  });

  it('returns null without a worktree path', () => {
    expect(sessionWorktreeLabel({ worktreePath: null })).toBeNull();
    expect(sessionWorktreeLabel({ worktreePath: '   ' })).toBeNull();
  });
});
