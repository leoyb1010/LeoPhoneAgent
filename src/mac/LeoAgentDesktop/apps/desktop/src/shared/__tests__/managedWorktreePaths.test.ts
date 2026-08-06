import { describe, expect, it } from 'vitest';

import {
  getManagedWorktreeBasePath,
  isManagedWorktreeDirectoryName,
  MANAGED_WORKTREE_DIR_NAME,
} from '../managedWorktreePaths';

describe('managed worktree paths', () => {
  it('uses the Cindy-branded directory for newly created worktrees', () => {
    expect(MANAGED_WORKTREE_DIR_NAME).toBe('.cindy-worktrees');
  });

  it('resolves current and legacy managed worktrees to the base repo', () => {
    expect(getManagedWorktreeBasePath('/repo/.cindy-worktrees/new-one/src')).toBe('/repo');
    expect(getManagedWorktreeBasePath('/repo/.xdt-worktrees/old-one/src')).toBe('/repo');
    expect(getManagedWorktreeBasePath('D:/.cindy-worktrees/new-one')).toBe('D:/');
  });

  it('does not claim user-managed worktree directory conventions', () => {
    expect(getManagedWorktreeBasePath('/repo/.worktrees/user-one')).toBeNull();
    expect(isManagedWorktreeDirectoryName('.cindy-worktrees')).toBe(true);
    expect(isManagedWorktreeDirectoryName('.xdt-worktrees')).toBe(true);
    expect(isManagedWorktreeDirectoryName('.worktrees')).toBe(false);
  });
});
