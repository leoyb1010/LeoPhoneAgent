/**
 * Shared capped-diff thresholds and summary helpers.
 *
 * Capped mode mirrors Codex desktop: large source diffs load file summaries
 * first and defer patch parsing to one file at a time.
 */

import type {
  FileDiff,
  ReviewDiffSummaryEntry,
} from './types.js';
import { runGit } from './gitRunner.js';
import {
  SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
  SINGLE_FILE_CHANGED_LINES_THRESHOLD,
  SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD,
} from '../../shared/gitReviewCapped.js';
export {
  buildCappedDiffData,
  cappedReasonForStats,
  CAPPED_DIFF_CHANGED_BYTES_THRESHOLD,
  CAPPED_DIFF_CHANGED_LINES_THRESHOLD,
  CAPPED_DIFF_FILE_COUNT_THRESHOLD,
  CAPPED_DIFF_HARD_FILE_COUNT_GUARD,
  SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
  SINGLE_FILE_CHANGED_LINES_THRESHOLD,
  SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD,
  summarizeDiffEntries,
} from '../../shared/gitReviewCapped.js';

export interface ParsedNumstat {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface DiffSummaryInput {
  idPrefix?: string;
  source: FileDiff['source'];
  path: string;
  oldPath: string | null;
  status: ReviewDiffSummaryEntry['status'];
  additions?: number;
  deletions?: number;
  changedBytes?: number | null;
  isBinary?: boolean;
  isSubmodule?: boolean;
}

export interface GitBlobSizeItem {
  key: string;
  treeish: string | null;
  gitPath: string | null;
}

export interface GitObjectSizeItem {
  key: string;
  objectName: string | null;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readBlobSize(repoRoot: string, treeish: string | null, gitPath: string | null): Promise<number | null> {
  if (!treeish || !gitPath) return null;
  try {
    const { stdout } = await runGit(['cat-file', '-s', `${treeish}:${gitPath}`], { cwd: repoRoot });
    const size = Number(stdout.trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

export async function readObjectSizeMap(
  repoRoot: string,
  items: readonly GitObjectSizeItem[],
  concurrency = 8,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batchItems = items.filter((item) => item.objectName && /^[0-9a-f]{4,64}$/iu.test(item.objectName));
  if (batchItems.length > 0) {
    try {
      const stdin = `${batchItems.map((item) => item.objectName).join('\n')}\n`;
      const { stdout } = await runGit(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
        cwd: repoRoot,
        stdin,
        maxStdoutBytes: Math.max(1024 * 1024, batchItems.length * 64),
      });
      const lines = stdout.split('\n');
      for (let i = 0; i < batchItems.length; i += 1) {
        const line = lines[i] ?? '';
        const [, sizeText] = line.split(' ');
        const size = Number(sizeText);
        if (Number.isFinite(size)) out.set(batchItems[i].key, size);
      }
    } catch {
      // Fall through to per-object reads for any missing entries.
    }
  }
  await mapWithConcurrency(batchItems.filter((item) => !out.has(item.key)), concurrency, async (item) => {
    try {
      const { stdout } = await runGit(['cat-file', '-s', item.objectName!], { cwd: repoRoot });
      const size = Number(stdout.trim());
      if (Number.isFinite(size)) out.set(item.key, size);
    } catch {
      // Missing objects are treated as unknown size.
    }
  });
  return out;
}

export async function readBlobSizeMap(
  repoRoot: string,
  items: readonly GitBlobSizeItem[],
  concurrency = 8,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batchItems = items.filter((item) =>
    item.treeish &&
    item.gitPath &&
    !item.gitPath.includes('\n') &&
    !item.gitPath.includes('\r'));
  if (batchItems.length > 0) {
    try {
      const stdin = `${batchItems.map((item) => `${item.treeish}:${item.gitPath}`).join('\n')}\n`;
      const { stdout } = await runGit(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
        cwd: repoRoot,
        stdin,
        maxStdoutBytes: Math.max(1024 * 1024, batchItems.length * 64),
      });
      const lines = stdout.split('\n');
      for (let i = 0; i < batchItems.length; i += 1) {
        const line = lines[i] ?? '';
        const [, sizeText] = line.split(' ');
        const size = Number(sizeText);
        if (Number.isFinite(size)) out.set(batchItems[i].key, size);
      }
    } catch {
      // Fall through to per-file reads for any missing entries.
    }
  }
  await mapWithConcurrency(items.filter((item) => !out.has(item.key)), concurrency, async (item) => {
    const size = await readBlobSize(repoRoot, item.treeish, item.gitPath);
    if (size !== null) out.set(item.key, size);
  });
  return out;
}

export function makeDiffSummaryId(source: FileDiff['source'], path: string, idPrefix?: string): string {
  return idPrefix ? `${source}:${idPrefix}:${path}` : `${source}:${path}`;
}

export function parseNumstat(stdout: string): Map<string, ParsedNumstat> {
  const fields = stdout.split('\0').filter(Boolean);
  const out = new Map<string, ParsedNumstat>();
  let i = 0;
  while (i < fields.length) {
    const field = fields[i] ?? '';
    i += 1;
    const parts = field.split('\t');
    if (parts.length < 2) continue;
    const isBinary = parts[0] === '-' || parts[1] === '-';
    const additions = isBinary ? 0 : Number(parts[0]);
    const deletions = isBinary ? 0 : Number(parts[1]);
    const inlinePath = parts.slice(2).join('\t');
    let pathName = inlinePath;
    if (!pathName) {
      const oldPath = fields[i] ?? '';
      const newPath = fields[i + 1] ?? '';
      i += newPath ? 2 : oldPath ? 1 : 0;
      pathName = newPath || oldPath;
    }
    if (!pathName) continue;
    out.set(pathName, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      isBinary,
    });
  }
  return out;
}

export function createDiffSummaryEntry(input: DiffSummaryInput): ReviewDiffSummaryEntry {
  const additions = Math.max(0, input.additions ?? 0);
  const deletions = Math.max(0, input.deletions ?? 0);
  const changedBytes = Math.max(0, input.changedBytes ?? 0);
  return {
    id: makeDiffSummaryId(input.source, input.path, input.idPrefix),
    source: input.source,
    path: input.path,
    oldPath: input.oldPath,
    status: input.status,
    additions,
    deletions,
    changedLines: additions + deletions,
    changedBytes,
    isBinary: input.isBinary ?? false,
    isSubmodule: input.isSubmodule ?? false,
  };
}

export function maxPatchLineBytes(rawPatch: string): number {
  let max = 0;
  for (const line of rawPatch.split('\n')) {
    max = Math.max(max, Buffer.byteLength(line, 'utf8'));
  }
  return max;
}

export function singleFileTooLargeReason(input: {
  changedLines: number;
  changedBytes: number;
  maxLineBytes?: number;
}): 'changed-lines' | 'changed-bytes' | 'max-line-bytes' | null {
  if (input.changedLines > SINGLE_FILE_CHANGED_LINES_THRESHOLD) return 'changed-lines';
  if (input.changedBytes > SINGLE_FILE_CHANGED_BYTES_THRESHOLD) return 'changed-bytes';
  if ((input.maxLineBytes ?? 0) > SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD) return 'max-line-bytes';
  return null;
}
