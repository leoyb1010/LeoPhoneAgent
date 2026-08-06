/**
 * Explicit user commit operation for git-review.
 *
 * Commits use the repository's normal hooks and GPG settings. The caller must
 * hold gitRepoWriteQueue for the repo root before invoking this module.
 */

import { GitRunError, runGit } from './gitRunner.js';
import type { ReviewScope, ReviewStatus } from './types.js';

const GIT_WRITE_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export interface CommitStagedChangesOptions {
  includeUnstaged?: boolean;
}

export class GitReviewCommitError extends Error {
  readonly stderr?: string;

  constructor(message: string, stderr?: string) {
    super(message);
    this.name = 'GitReviewCommitError';
    this.stderr = stderr;
  }
}

function assertCanCommit(
  scope: ReviewScope,
  status: ReviewStatus,
  message: string,
  options: CommitStagedChangesOptions,
): string {
  if (scope.disabledReason || !scope.repoRoot) {
    throw new GitReviewCommitError(scope.disabledMessage ?? 'git review is unavailable');
  }
  if (message.trim() === '') throw new GitReviewCommitError('commit message is required');
  if (status.writeDisabledReasons.length > 0) {
    throw new GitReviewCommitError(`git commit is disabled: ${status.writeDisabledReasons.join(', ')}`);
  }
  if (options.includeUnstaged && !status.dirty) {
    throw new GitReviewCommitError('there are no changes to commit');
  }
  if (!options.includeUnstaged && status.stagedCount === 0) {
    throw new GitReviewCommitError('there are no staged changes to commit');
  }
  return scope.repoRoot;
}

export async function commitStagedChanges(
  scope: ReviewScope,
  status: ReviewStatus,
  message: string,
  options: CommitStagedChangesOptions = {},
): Promise<{ commitOid: string; stdout: string; stderr: string }> {
  const repoRoot = assertCanCommit(scope, status, message, options);
  try {
    if (options.includeUnstaged) {
      await runGit(['add', '-A', '--', ':/'], {
        cwd: repoRoot,
        timeoutMs: 120_000,
      });
    }
    const result = await runGit(['commit', '-F', '-'], {
      cwd: repoRoot,
      stdin: message,
      timeoutMs: 120_000,
      maxStdoutBytes: GIT_WRITE_MAX_STDOUT_BYTES,
    });
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
    return { commitOid: stdout.trim(), stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err instanceof GitRunError) {
      throw new GitReviewCommitError(err.stderr || err.message, err.stderr);
    }
    throw err;
  }
}
