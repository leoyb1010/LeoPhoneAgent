/**
 * Stage / unstage / discard operations for git-review.
 *
 * All exported functions expect the caller to hold gitRepoWriteQueue for the
 * repo root. This module keeps each git mutation deterministic and avoids
 * fallback merge strategies such as `git apply --3way`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { GitRunError, runGit } from './gitRunner.js';
import { readFileDiff } from './diffReader.js';
import { RepoContainedPathError, isPathInside, resolveRepoContainedRealPath } from './fsPathGuard.js';
import { formatPatchForSelection, PatchFormatError } from './patchFormatter.js';
import { readStatus } from './statusReader.js';
import type {
  DiffSelection,
  DiffLine,
  FileDiff,
  FileStatus,
  ReviewDiffReadOptions,
  ReviewFileTarget,
  ReviewScope,
  ReviewStageAction,
  ReviewStageOperationSummary,
  ReviewStatus,
} from './types.js';

export class GitReviewStageError extends Error {
  readonly stderr?: string;
  readonly kind: 'stale' | 'generic';

  constructor(message: string, stderr?: string, kind: 'stale' | 'generic' = 'generic') {
    super(message);
    this.name = 'GitReviewStageError';
    this.stderr = stderr;
    this.kind = kind;
  }
}

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

function targetLabel(target: Pick<ReviewFileTarget, 'path'>): string {
  return target.path;
}

function assertWritable(scope: ReviewScope, status: ReviewStatus): string {
  if (scope.disabledReason || !scope.repoRoot) {
    throw new GitReviewStageError(scope.disabledMessage ?? 'git review is unavailable');
  }
  if (status.writeDisabledReasons.length > 0) {
    throw new GitReviewStageError(`git write is disabled: ${status.writeDisabledReasons.join(', ')}`);
  }
  return scope.repoRoot;
}

function pathspecsForTarget(target: ReviewFileTarget): string[] {
  return [target.oldPath, target.path]
    .filter((p): p is string => Boolean(p))
    .map(literalPathspec);
}

function currentPathspecForTarget(target: ReviewFileTarget): string[] {
  return [literalPathspec(target.path)];
}

function findFileForTarget(
  status: ReviewStatus,
  source: 'staged' | 'unstaged',
  target: ReviewFileTarget,
): FileStatus | null {
  if (target.source !== source) return null;
  return status.files.find((file) =>
    file.path === target.path &&
    file.oldPath === target.oldPath &&
    file.sources.includes(source),
  ) ?? null;
}

function assertFreshFileTarget(
  status: ReviewStatus,
  source: 'staged' | 'unstaged',
  target: ReviewFileTarget,
): FileStatus {
  const file = findFileForTarget(status, source, target);
  if (!file) throw new GitReviewStageError('diff is stale; refresh and retry', undefined, 'stale');
  return file;
}

function targetFromStatus(file: FileStatus, source: 'staged' | 'unstaged'): ReviewFileTarget {
  return {
    path: file.path,
    oldPath: file.oldPath,
    source,
  };
}

function toRepoFsPath(repoRoot: string, gitPath: string): string {
  if (!gitPath || path.isAbsolute(gitPath)) {
    throw new GitReviewStageError(`invalid git path: ${gitPath}`);
  }
  const abs = path.resolve(repoRoot, ...gitPath.split('/'));
  const rel = path.relative(repoRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GitReviewStageError(`refusing to modify path outside repository: ${gitPath}`);
  }
  return abs;
}

async function resolveUntrackedDiscardPath(repoRoot: string, gitPath: string): Promise<string> {
  const fsPath = toRepoFsPath(repoRoot, gitPath);
  try {
    const linkStat = await fs.lstat(fsPath);
    if (linkStat.isSymbolicLink()) {
      const [repoRootReal, parentReal] = await Promise.all([
        fs.realpath(repoRoot),
        fs.realpath(path.dirname(fsPath)),
      ]);
      if (!isPathInside(repoRootReal, parentReal)) {
        throw new GitReviewStageError(`refusing to discard path outside repository: ${gitPath}`);
      }
      return fsPath;
    }
  } catch (err) {
    if (err instanceof GitReviewStageError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new GitReviewStageError(`untracked path is missing: ${gitPath}`);
    throw err;
  }
  try {
    const { targetReal } = await resolveRepoContainedRealPath(repoRoot, gitPath);
    return targetReal;
  } catch (err) {
    if (err instanceof RepoContainedPathError) {
      throw new GitReviewStageError(`refusing to discard path outside repository: ${gitPath}`);
    }
    throw err;
  }
}

async function restoreStaged(repoRoot: string, target: ReviewFileTarget): Promise<void> {
  const pathspecs = pathspecsForTarget(target);
  try {
    await runGit(['restore', '--staged', '--', ...pathspecs], { cwd: repoRoot });
  } catch (err) {
    if (!(err instanceof GitRunError)) throw err;
    await runGit(['reset', '-q', 'HEAD', '--', ...pathspecs], { cwd: repoRoot });
  }
}

export async function stageFile(scope: ReviewScope, status: ReviewStatus, target: ReviewFileTarget): Promise<void> {
  const repoRoot = assertWritable(scope, status);
  const file = assertFreshFileTarget(status, target.source, target);
  const freshTarget = targetFromStatus(file, target.source);
  if (freshTarget.oldPath) {
    await runGit(['rm', '--cached', '--ignore-unmatch', '-q', '--', literalPathspec(freshTarget.oldPath)], {
      cwd: repoRoot,
    });
  }
  await runGit(['add', '--', literalPathspec(freshTarget.path)], { cwd: repoRoot });
}

export async function unstageFile(scope: ReviewScope, status: ReviewStatus, target: ReviewFileTarget): Promise<void> {
  const repoRoot = assertWritable(scope, status);
  const file = assertFreshFileTarget(status, 'staged', target);
  await restoreStaged(repoRoot, targetFromStatus(file, 'staged'));
}

export async function discardFile(scope: ReviewScope, status: ReviewStatus, target: ReviewFileTarget): Promise<void> {
  const repoRoot = assertWritable(scope, status);
  const file = assertFreshFileTarget(status, 'unstaged', target);

  if (file.isUntracked) {
    await fs.rm(await resolveUntrackedDiscardPath(repoRoot, file.path), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    return;
  }

  await runGit(['restore', '--', ...currentPathspecForTarget(targetFromStatus(file, 'unstaged'))], { cwd: repoRoot });
}

function findStatusForTarget(status: ReviewStatus, source: 'staged' | 'unstaged', diff: FileDiff): FileStatus | null {
  return status.files.find((file) =>
    file.path === diff.path &&
    file.sources.includes(source) &&
    (diff.oldPath ? file.oldPath === diff.oldPath : true),
  ) ?? null;
}

function isPartialForbidden(diff: FileDiff): string | null {
  if (diff.kind !== 'text') return diff.kind;
  if (diff.isSubmodule) return 'submodule';
  if (diff.isBinary) return 'binary';
  if (diff.status === 'renamed' || diff.status === 'copied') return 'rename';
  if (diff.status === 'typechange') return 'typechange';
  if (
    diff.mode.old &&
    diff.mode.new &&
    diff.mode.old !== '000000' &&
    diff.mode.new !== '000000' &&
    diff.mode.old !== diff.mode.new
  ) {
    return 'typechange';
  }
  return null;
}

function selectionCoversAllSelectable(diff: FileDiff, selection: DiffSelection): boolean {
  const selectedByHunk = new Map(selection.lines.map((item) => [item.hunkIndex, new Set(item.lineIndices)]));
  let sawSelectable = false;
  for (const hunk of diff.hunks) {
    const selected = selectedByHunk.get(hunk.index) ?? new Set<number>();
    for (const lineIndex of hunk.selectableLines) {
      sawSelectable = true;
      if (!selected.has(lineIndex)) return false;
    }
  }
  return sawSelectable;
}

function assertFreshDiff(expected: FileDiff, current: FileDiff): void {
  if (
    expected.rawPatch !== current.rawPatch ||
    expected.index.oldOid !== current.index.oldOid ||
    expected.index.newOid !== current.index.newOid ||
    expected.kind !== current.kind
  ) {
    throw new GitReviewStageError('diff is stale; refresh and retry', undefined, 'stale');
  }
}

async function readCurrentDiff(
  scope: ReviewScope,
  source: 'staged' | 'unstaged',
  expected: FileDiff,
  options: ReviewDiffReadOptions = {},
): Promise<FileDiff> {
  if (!scope.repoRoot) throw new GitReviewStageError('No git repository');
  const status = await readStatus(scope);
  const file = findStatusForTarget(status, source, expected);
  if (!file) throw new GitReviewStageError('diff is stale; refresh and retry', undefined, 'stale');
  return readFileDiff(status.scope, source, file, options);
}

function normalizedContent(content: string): string {
  return content.replace(/\s+/g, '');
}

function selectedLineKeys(diff: FileDiff, selection: DiffSelection): Array<{
  type: DiffLine['type'];
  lineNumber: number | null;
  normalized: string;
}> {
  const keys: Array<{ type: DiffLine['type']; lineNumber: number | null; normalized: string }> = [];
  for (const item of selection.lines) {
    const hunk = diff.hunks.find((candidate) => candidate.index === item.hunkIndex);
    if (!hunk) continue;
    const selected = new Set(item.lineIndices);
    for (const line of hunk.lines) {
      if (!line.selectable || !selected.has(line.index)) continue;
      keys.push({
        type: line.type,
        lineNumber: line.type === 'add' ? line.newLineNumber : line.oldLineNumber,
        normalized: normalizedContent(line.content),
      });
    }
  }
  return keys;
}

function mapWhitespaceHiddenStageSelection(filteredDiff: FileDiff, fullDiff: FileDiff, selection: DiffSelection): DiffSelection {
  const keys = selectedLineKeys(filteredDiff, selection);
  if (keys.length === 0) return selection;

  const matchedByHunk = new Map<number, number[]>();
  const used = new Set<string>();
  for (const key of keys) {
    let matched: { hunkIndex: number; lineIndex: number } | null = null;
    for (const hunk of fullDiff.hunks) {
      for (const line of hunk.lines) {
        const id = `${hunk.index}:${line.index}`;
        if (used.has(id) || !line.selectable || line.type !== key.type) continue;
        const lineNumber = line.type === 'add' ? line.newLineNumber : line.oldLineNumber;
        if (lineNumber !== key.lineNumber) continue;
        if (normalizedContent(line.content) !== key.normalized) continue;
        matched = { hunkIndex: hunk.index, lineIndex: line.index };
        used.add(id);
        break;
      }
      if (matched) break;
    }
    if (!matched) {
      throw new GitReviewStageError('cannot map hidden-whitespace hunk to the current diff; refresh and retry', undefined, 'stale');
    }
    const lines = matchedByHunk.get(matched.hunkIndex) ?? [];
    lines.push(matched.lineIndex);
    matchedByHunk.set(matched.hunkIndex, lines);
  }

  return {
    lines: Array.from(matchedByHunk.entries()).map(([hunkIndex, lineIndices]) => ({
      hunkIndex,
      lineIndices,
    })),
  };
}

async function resolvePatchDiffAndSelection(
  scope: ReviewScope,
  source: 'staged' | 'unstaged',
  action: ReviewStageAction,
  currentDiff: FileDiff,
  selection: DiffSelection,
  options: ReviewDiffReadOptions,
): Promise<{ diff: FileDiff; selection: DiffSelection }> {
  if (!options.ignoreWhitespace || action !== 'stage') {
    return { diff: currentDiff, selection };
  }

  const fullDiff = await readCurrentDiff(scope, source, currentDiff, { ignoreWhitespace: false });
  const forbidden = isPartialForbidden(fullDiff);
  if (forbidden) throw new GitReviewStageError(`partial ${action} is not supported for ${forbidden} files`);
  return {
    diff: fullDiff,
    selection: mapWhitespaceHiddenStageSelection(currentDiff, fullDiff, selection),
  };
}

export async function applyHunkSelection(
  scope: ReviewScope,
  status: ReviewStatus,
  action: ReviewStageAction,
  expectedDiff: FileDiff,
  selection: DiffSelection,
  options: ReviewDiffReadOptions = {},
): Promise<void> {
  const repoRoot = assertWritable(scope, status);
  const source = action === 'stage' || action === 'discard' ? 'unstaged' : 'staged';
  if (expectedDiff.source !== source) {
    throw new GitReviewStageError(`cannot ${action} ${expectedDiff.source} diff`);
  }

  const currentDiff = await readCurrentDiff(scope, source, expectedDiff, options);
  assertFreshDiff(expectedDiff, currentDiff);
  const forbidden = isPartialForbidden(currentDiff);
  if (forbidden) throw new GitReviewStageError(`partial ${action} is not supported for ${forbidden} files`);

  if (
    action === 'unstage' &&
    currentDiff.status === 'added' &&
    selectionCoversAllSelectable(currentDiff, selection)
  ) {
    await restoreStaged(repoRoot, {
      path: currentDiff.path,
      oldPath: currentDiff.oldPath,
      source: 'staged',
    });
    return;
  }

  const patchInput = await resolvePatchDiffAndSelection(scope, source, action, currentDiff, selection, options);
  const formatDiff = action === 'unstage' && patchInput.diff.status === 'added'
    ? { ...patchInput.diff, status: 'modified' as const }
    : patchInput.diff;
  let patch: string;
  try {
    patch = formatPatchForSelection(formatDiff, patchInput.selection);
  } catch (err) {
    if (err instanceof PatchFormatError) throw new GitReviewStageError(err.message);
    throw err;
  }

  const args = ['apply'];
  if (action !== 'discard') args.push('--cached');
  if (action === 'unstage' || action === 'discard') args.push('-R');
  args.push('--unidiff-zero', '--whitespace=nowarn', '-');
  try {
    await runGit(args, { cwd: repoRoot, stdin: patch });
  } catch (err) {
    if (err instanceof GitRunError) {
      throw new GitReviewStageError('diff is stale; refresh and retry', err.stderr || err.message, 'stale');
    }
    throw err;
  }
}

async function runFileAction(
  scope: ReviewScope,
  status: ReviewStatus,
  action: ReviewStageAction,
  target: ReviewFileTarget,
): Promise<void> {
  if (action === 'stage') await stageFile(scope, status, target);
  else if (action === 'unstage') await unstageFile(scope, status, target);
  else await discardFile(scope, status, target);
}

export async function applyFileBatch(
  scope: ReviewScope,
  status: ReviewStatus,
  action: ReviewStageAction,
  targets: ReviewFileTarget[],
): Promise<ReviewStageOperationSummary> {
  assertWritable(scope, status);
  const summary: ReviewStageOperationSummary = {
    action,
    succeeded: [],
    failed: [],
    partial: false,
  };
  for (const target of targets) {
    try {
      await runFileAction(scope, status, action, target);
      summary.succeeded.push(targetLabel(target));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed.push({
        path: targetLabel(target),
        error: message,
        stderr: err instanceof GitReviewStageError ? err.stderr : err instanceof GitRunError ? err.stderr : undefined,
      });
      summary.partial = summary.succeeded.length > 0;
      if (!(err instanceof GitReviewStageError && err.kind === 'stale')) break;
    }
  }
  return summary;
}
