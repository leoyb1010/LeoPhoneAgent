/**
 * Shared capped-diff thresholds and pure summary helpers.
 *
 * Main owns git IO, but renderer also needs the exact capped decision when it
 * narrows an already-capped worktree diff to a last-turn subset.
 */

import type {
  ReviewCappedDiffData,
  ReviewCappedDiffReason,
  ReviewCappedDiffStats,
  ReviewDiffSummaryEntry,
} from './gitReviewWire';

export const CAPPED_DIFF_FILE_COUNT_THRESHOLD = 128;
export const CAPPED_DIFF_CHANGED_LINES_THRESHOLD = 9000;
export const CAPPED_DIFF_CHANGED_BYTES_THRESHOLD = 12 * 1024 * 1024;

export const SINGLE_FILE_CHANGED_LINES_THRESHOLD = 15000;
export const SINGLE_FILE_CHANGED_BYTES_THRESHOLD = 3 * 1024 * 1024;
export const SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD = 1024 * 1024;

// Safety valve only. Normal large diffs should enter capped mode instead of
// surfacing a hard-reject empty state.
export const CAPPED_DIFF_HARD_FILE_COUNT_GUARD = 5000;

export function summarizeDiffEntries(entries: readonly ReviewDiffSummaryEntry[]): ReviewCappedDiffStats {
  return {
    fileCount: entries.length,
    totalChangedLines: entries.reduce((sum, entry) => sum + entry.changedLines, 0),
    totalChangedBytes: entries.reduce((sum, entry) => sum + entry.changedBytes, 0),
  };
}

export function cappedReasonForStats(stats: ReviewCappedDiffStats): ReviewCappedDiffReason | null {
  if (stats.fileCount > CAPPED_DIFF_FILE_COUNT_THRESHOLD) return 'file-count';
  if (stats.totalChangedLines > CAPPED_DIFF_CHANGED_LINES_THRESHOLD) return 'changed-lines';
  if (stats.totalChangedBytes > CAPPED_DIFF_CHANGED_BYTES_THRESHOLD) return 'changed-bytes';
  return null;
}

export function buildCappedDiffData(entries: readonly ReviewDiffSummaryEntry[]): ReviewCappedDiffData | null {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const stats = summarizeDiffEntries(sorted);
  const reason = cappedReasonForStats(stats);
  return reason ? { reason, stats, files: sorted } : null;
}
