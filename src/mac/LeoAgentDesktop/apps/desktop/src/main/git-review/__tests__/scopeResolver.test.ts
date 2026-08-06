import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveReviewScope, type ScopeResolverDeps } from '../scopeResolver';
import type { GitRunResult } from '../gitRunner';

function deps(patch: Partial<ScopeResolverDeps> = {}): ScopeResolverDeps {
  return {
    getSessionRow: vi.fn().mockResolvedValue({
      id: 's1',
      workingDir: '/repo/main',
      worktreePath: '/repo/wt-db',
      remoteHostId: null,
    }),
    getManagedWorktreePath: vi.fn().mockReturnValue('/repo/wt-store'),
    resolveSessionDir: vi.fn().mockResolvedValue({
      workdir: '/repo/wt-store',
      head: { kind: 'branch', branch: 'xdt/task', shortSha: 'abc1234' },
      source: 'worktree',
    }),
    git: vi.fn().mockImplementation(async (args: readonly string[]): Promise<GitRunResult> => {
      if (args.includes('--show-toplevel')) return { stdout: '/repo/wt-store\n', stderr: '', exitCode: 0 };
      if (args.includes('--verify')) return { stdout: 'abcdef\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    ...patch,
  };
}

describe('git-review scopeResolver', () => {
  it('prefers managed WorktreeStore path over DB snapshot fallback', async () => {
    const d = deps();
    const scope = await resolveReviewScope('s1', d);

    expect(d.resolveSessionDir).toHaveBeenCalledWith({
      sessionId: 's1',
      fallbackWorktreePath: '/repo/wt-store',
      fallbackWorkingDir: '/repo/main',
    });
    // 生产侧会对 workdir/repoRoot 做 path.resolve,win32 下补盘符,期望值同样 resolve。
    expect(scope).toMatchObject({
      workdir: path.resolve('/repo/wt-store'),
      repoRoot: path.resolve('/repo/wt-store'),
      branch: 'xdt/task',
      disabledReason: null,
    });
  });

  it('returns a remote-session disabled scope before probing local paths', async () => {
    const d = deps({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 's1',
        workingDir: '/remote/repo',
        worktreePath: null,
        remoteHostId: 'host-1',
      }),
    });

    const scope = await resolveReviewScope('s1', d);

    expect(scope.disabledReason).toBe('remote-session');
    expect(d.resolveSessionDir).not.toHaveBeenCalled();
  });

  it('falls back to non-git disabled scope when no workdir resolves', async () => {
    const d = deps({
      resolveSessionDir: vi.fn().mockResolvedValue({ workdir: null, head: null, source: null }),
    });

    const scope = await resolveReviewScope('s1', d);

    expect(scope.disabledReason).toBe('non-git');
    expect(scope.resolutionChain.map((item) => item.source)).toEqual(['telemetry', 'worktree', 'workingDir']);
  });
});
