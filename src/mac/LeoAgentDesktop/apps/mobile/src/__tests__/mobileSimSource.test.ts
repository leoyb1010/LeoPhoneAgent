import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSourceIdentity } from '../../scripts/sim-metro.mjs';

describe('mobile simulator source identity', () => {
  it('uses branch and commit for a clean worktree', () => {
    expect(gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: '', diff: '' }),
    })).toBe('carol/feature@abc123456');
  });

  it('changes when dirty tracked content changes without a commit', () => {
    const first = gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: ' M file.ts', diff: '-old\n+one' }),
    });
    const second = gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: ' M file.ts', diff: '-old\n+two' }),
    });

    expect(first).toMatch(/^carol\/feature@abc123456\+[a-f0-9]{10}$/);
    expect(second).not.toBe(first);
  });

  it('changes when untracked file content changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-mobile-source-'));
    try {
      const filePath = join(root, 'new.ts');
      writeFileSync(filePath, 'one\n');
      const first = gitSourceIdentity(root, {
        execFile: fakeGit({ status: '?? new.ts\0', diff: '' }),
      });
      writeFileSync(filePath, 'two\n');
      const second = gitSourceIdentity(root, {
        execFile: fakeGit({ status: '?? new.ts\0', diff: '' }),
      });

      expect(second).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeGit({ status, diff }: { status: string; diff: string }) {
  return (_command: string, args: string[]) => {
    if (args[0] === 'branch') return 'carol/feature\n';
    if (args[0] === 'rev-parse') return 'abc123456\n';
    if (args[0] === 'status') return status;
    if (args[0] === 'diff') return diff;
    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  };
}
