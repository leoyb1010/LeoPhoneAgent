/**
 * Explicit user push operation for git-review.
 *
 * Pushes use normal Git credential helpers and pre-push hooks. The caller must
 * hold gitRepoWriteQueue for the repo root before invoking this module.
 */

import { GitRunError, runGit } from './gitRunner.js';
import type { ReviewPushConfirmForce, ReviewScope, ReviewStatus } from './types.js';

const GIT_WRITE_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

interface PushTarget {
  remote: string;
  remoteBranch: string;
  remoteRef: string;
  trackingRef: string;
  upstream: string | null;
  hasUpstream: boolean;
}

export type GitReviewPushOperation =
  | {
      kind: 'pushed';
      remote: string;
      remoteRef: string;
      stdout: string;
      stderr: string;
    }
  | {
      kind: 'needs-force';
      remote: string;
      remoteRef: string;
      remoteOid: string;
      ahead: number;
      behind: number;
      upstream: string | null;
      stderr: string;
    };

export type GitReviewPushErrorKind = 'lease-expired' | 'no-remote' | 'generic';

export class GitReviewPushError extends Error {
  readonly stderr?: string;
  readonly kind: GitReviewPushErrorKind;

  constructor(message: string, stderr?: string, kind: GitReviewPushErrorKind = 'generic') {
    super(message);
    this.name = 'GitReviewPushError';
    this.stderr = stderr;
    this.kind = kind;
  }
}

function assertCanPush(scope: ReviewScope, status: ReviewStatus): { repoRoot: string; branch: string } {
  if (scope.disabledReason || !scope.repoRoot) {
    throw new GitReviewPushError(scope.disabledMessage ?? 'git review is unavailable');
  }
  if (status.writeDisabledReasons.length > 0) {
    throw new GitReviewPushError(`git push is disabled: ${status.writeDisabledReasons.join(', ')}`);
  }
  if (!scope.branch) throw new GitReviewPushError('current git branch is unavailable');
  return { repoRoot: scope.repoRoot, branch: scope.branch };
}

async function readConfigValue(repoRoot: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', key], { cwd: repoRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function listRemotes(repoRoot: string): Promise<string[]> {
  const { stdout } = await runGit(['remote'], { cwd: repoRoot });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseUpstream(upstream: string): { remote: string; remoteBranch: string } {
  const slash = upstream.indexOf('/');
  if (slash <= 0 || slash === upstream.length - 1) {
    throw new GitReviewPushError(`unsupported upstream ref: ${upstream}`);
  }
  return {
    remote: upstream.slice(0, slash),
    remoteBranch: upstream.slice(slash + 1),
  };
}

function parseMergeBranch(mergeRef: string): string {
  return mergeRef.startsWith('refs/heads/') ? mergeRef.slice('refs/heads/'.length) : mergeRef;
}

async function readConfiguredUpstream(repoRoot: string, branch: string): Promise<{ remote: string; remoteBranch: string } | null> {
  const [remote, mergeRef] = await Promise.all([
    readConfigValue(repoRoot, `branch.${branch}.remote`),
    readConfigValue(repoRoot, `branch.${branch}.merge`),
  ]);
  const remoteBranch = mergeRef ? parseMergeBranch(mergeRef) : null;
  if (!remote || !remoteBranch) return null;
  return { remote, remoteBranch };
}

function parseUpstreamByRemotePrefix(upstream: string, remotes: readonly string[]): { remote: string; remoteBranch: string } | null {
  for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
    if (remote === '.') continue;
    const prefix = `${remote}/`;
    if (upstream.startsWith(prefix) && upstream.length > prefix.length) {
      return {
        remote,
        remoteBranch: upstream.slice(prefix.length),
      };
    }
  }
  return null;
}

function assertPushableRemote(remote: string): void {
  if (remote === '.') {
    throw new GitReviewPushError(
      'local upstream branches are not supported for review push; configure a remote upstream',
      undefined,
      'no-remote',
    );
  }
}

function targetFor(remote: string, remoteBranch: string, upstream: string | null, hasUpstream: boolean): PushTarget {
  assertPushableRemote(remote);
  return {
    remote,
    remoteBranch,
    remoteRef: `refs/heads/${remoteBranch}`,
    trackingRef: `refs/remotes/${remote}/${remoteBranch}`,
    upstream,
    hasUpstream,
  };
}

async function resolveFirstPushRemote(repoRoot: string, branch: string): Promise<string> {
  const explicit =
    await readConfigValue(repoRoot, `branch.${branch}.pushRemote`) ??
    await readConfigValue(repoRoot, 'remote.pushDefault');
  const remotes = await listRemotes(repoRoot);
  if (explicit) {
    if (!remotes.includes(explicit)) {
      throw new GitReviewPushError(`git remote ${explicit} is not configured`, undefined, 'no-remote');
    }
    return explicit;
  }

  if (remotes.length === 0) throw new GitReviewPushError('no git remote is configured', undefined, 'no-remote');
  if (!remotes.includes('origin')) {
    throw new GitReviewPushError('push remote origin is not configured', undefined, 'no-remote');
  }
  return 'origin';
}

async function resolvePushTarget(repoRoot: string, branch: string, upstream: string | null): Promise<PushTarget> {
  if (upstream) {
    const parsed =
      await readConfiguredUpstream(repoRoot, branch) ??
      parseUpstreamByRemotePrefix(upstream, await listRemotes(repoRoot)) ??
      parseUpstream(upstream);
    return targetFor(parsed.remote, parsed.remoteBranch, upstream, true);
  }
  const remote = await resolveFirstPushRemote(repoRoot, branch);
  return targetFor(remote, branch, null, false);
}

async function readTrackingOid(
  repoRoot: string,
  target: PushTarget,
  errorKind: GitReviewPushErrorKind = 'generic',
): Promise<string> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${target.trackingRef}^{commit}`], {
      cwd: repoRoot,
    });
    return stdout.trim();
  } catch (err) {
    if (err instanceof GitRunError) {
      throw new GitReviewPushError(
        `remote tracking ref is unavailable for ${target.remoteRef}; update it in terminal and retry`,
        err.stderr,
        errorKind,
      );
    }
    throw err;
  }
}

function isNonFastForwardRejection(err: GitRunError): boolean {
  const output = `${err.stdout}\n${err.stderr}`;
  return /non-fast-forward|fetch first|rejected.*\(fetch first\)|rejected.*\(non-fast-forward\)/i.test(output);
}

function isForceLeaseRejection(err: GitRunError): boolean {
  const output = `${err.stdout}\n${err.stderr}`;
  return /stale info|rejected.*\(stale info\)/i.test(output);
}

async function needsForceResult(
  repoRoot: string,
  status: ReviewStatus,
  target: PushTarget,
  stderr = '',
): Promise<GitReviewPushOperation> {
  const remoteOid = await readTrackingOid(repoRoot, target);
  return {
    kind: 'needs-force',
    remote: target.remote,
    remoteRef: target.remoteRef,
    remoteOid,
    ahead: status.scope.aheadBehind.ahead,
    behind: Math.max(status.scope.aheadBehind.behind, 1),
    upstream: target.upstream,
    stderr,
  };
}

async function pushNormally(
  repoRoot: string,
  branch: string,
  status: ReviewStatus,
  target: PushTarget,
): Promise<GitReviewPushOperation> {
  const localRef = `refs/heads/${branch}`;
  const refspec = `${localRef}:${target.remoteRef}`;
  const args = target.hasUpstream
    ? ['push', '--porcelain', target.remote, refspec]
    : ['push', '--porcelain', '--set-upstream', target.remote, refspec];
  try {
    const result = await runGit(args, { cwd: repoRoot, timeoutMs: 120_000, maxStdoutBytes: GIT_WRITE_MAX_STDOUT_BYTES });
    return {
      kind: 'pushed',
      remote: target.remote,
      remoteRef: target.remoteRef,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    if (err instanceof GitRunError && isNonFastForwardRejection(err)) {
      return needsForceResult(repoRoot, status, target, err.stderr || err.stdout);
    }
    if (err instanceof GitRunError) throw new GitReviewPushError(err.stderr || err.message, err.stderr);
    throw err;
  }
}

async function pushWithLease(
  repoRoot: string,
  branch: string,
  target: PushTarget,
  confirmForce: ReviewPushConfirmForce,
): Promise<GitReviewPushOperation> {
  if (confirmForce.remoteRef !== target.remoteRef) {
    throw new GitReviewPushError('remote ref changed; refresh and confirm again', undefined, 'lease-expired');
  }
  const currentTrackingOid = await readTrackingOid(repoRoot, target, 'lease-expired');
  if (currentTrackingOid !== confirmForce.expectedOid) {
    throw new GitReviewPushError('remote tracking ref changed; refresh and confirm again', undefined, 'lease-expired');
  }

  const localRef = `refs/heads/${branch}`;
  try {
    const result = await runGit([
      'push',
      '--porcelain',
      `--force-with-lease=${target.remoteRef}:${confirmForce.expectedOid}`,
      target.remote,
      `${localRef}:${target.remoteRef}`,
    ], { cwd: repoRoot, timeoutMs: 120_000, maxStdoutBytes: GIT_WRITE_MAX_STDOUT_BYTES });
    return {
      kind: 'pushed',
      remote: target.remote,
      remoteRef: target.remoteRef,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    if (err instanceof GitRunError) {
      if (isForceLeaseRejection(err)) {
        throw new GitReviewPushError('remote changed after confirmation; refresh and retry', err.stderr || err.stdout, 'lease-expired');
      }
      throw new GitReviewPushError(err.stderr || err.message, err.stderr);
    }
    throw err;
  }
}

export async function pushBranch(
  scope: ReviewScope,
  status: ReviewStatus,
  confirmForce?: ReviewPushConfirmForce,
): Promise<GitReviewPushOperation> {
  const { repoRoot, branch } = assertCanPush(scope, status);
  const target = await resolvePushTarget(repoRoot, branch, status.scope.aheadBehind.upstream);

  if (confirmForce) {
    if (status.scope.aheadBehind.ahead === 0) {
      throw new GitReviewPushError('local branch has no new commits to push; pushing would rewind the remote');
    }
    return pushWithLease(repoRoot, branch, target, confirmForce);
  }
  if (status.scope.aheadBehind.behind > 0) {
    // 纯落后(本地无新提交)不给 needs-force:强推只会把远端回退。分叉(ahead>0)才进入确认流程。
    if (status.scope.aheadBehind.ahead === 0) {
      throw new GitReviewPushError('local branch has no new commits to push; pushing would rewind the remote');
    }
    return needsForceResult(repoRoot, status, target);
  }
  return pushNormally(repoRoot, branch, status, target);
}
