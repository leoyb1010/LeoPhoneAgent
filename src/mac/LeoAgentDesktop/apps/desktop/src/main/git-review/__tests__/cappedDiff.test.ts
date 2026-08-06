import { describe, expect, it } from 'vitest';

import {
  buildCappedDiffData,
  CAPPED_DIFF_CHANGED_BYTES_THRESHOLD,
  CAPPED_DIFF_CHANGED_LINES_THRESHOLD,
  CAPPED_DIFF_FILE_COUNT_THRESHOLD,
  createDiffSummaryEntry,
  SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
  SINGLE_FILE_CHANGED_LINES_THRESHOLD,
  SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD,
  singleFileTooLargeReason,
} from '../cappedDiff';

function entry(index: number, overrides: Partial<Parameters<typeof createDiffSummaryEntry>[0]> = {}) {
  return createDiffSummaryEntry({
    source: 'branch',
    path: `file-${index}.txt`,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changedBytes: 1,
    ...overrides,
  });
}

describe('git-review cappedDiff thresholds', () => {
  it('pins Codex capped threshold literals', () => {
    expect(CAPPED_DIFF_FILE_COUNT_THRESHOLD).toBe(128);
    expect(CAPPED_DIFF_CHANGED_LINES_THRESHOLD).toBe(9000);
    expect(CAPPED_DIFF_CHANGED_BYTES_THRESHOLD).toBe(12 * 1024 * 1024);
    expect(SINGLE_FILE_CHANGED_LINES_THRESHOLD).toBe(15000);
    expect(SINGLE_FILE_CHANGED_BYTES_THRESHOLD).toBe(3 * 1024 * 1024);
    expect(SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD).toBe(1024 * 1024);
  });

  it('enters capped mode only when file count, changed lines, or changed bytes exceed Codex thresholds', () => {
    expect(buildCappedDiffData(Array.from({ length: CAPPED_DIFF_FILE_COUNT_THRESHOLD }, (_, index) => entry(index))))
      .toBeNull();
    expect(buildCappedDiffData(Array.from({ length: CAPPED_DIFF_FILE_COUNT_THRESHOLD + 1 }, (_, index) => entry(index))))
      .toMatchObject({ reason: 'file-count' });

    expect(buildCappedDiffData([entry(1, {
      additions: CAPPED_DIFF_CHANGED_LINES_THRESHOLD,
      deletions: 0,
      changedBytes: 1,
    })])).toBeNull();
    expect(buildCappedDiffData([entry(1, {
      additions: CAPPED_DIFF_CHANGED_LINES_THRESHOLD + 1,
      deletions: 0,
      changedBytes: 1,
    })])).toMatchObject({ reason: 'changed-lines' });

    expect(buildCappedDiffData([entry(1, {
      additions: 1,
      deletions: 0,
      changedBytes: CAPPED_DIFF_CHANGED_BYTES_THRESHOLD,
    })])).toBeNull();
    expect(buildCappedDiffData([entry(1, {
      additions: 1,
      deletions: 0,
      changedBytes: CAPPED_DIFF_CHANGED_BYTES_THRESHOLD + 1,
    })])).toMatchObject({ reason: 'changed-bytes' });
  });

  it('uses strict greater-than checks for per-file oversized guards', () => {
    expect(singleFileTooLargeReason({
      changedLines: SINGLE_FILE_CHANGED_LINES_THRESHOLD,
      changedBytes: 1,
    })).toBeNull();
    expect(singleFileTooLargeReason({
      changedLines: SINGLE_FILE_CHANGED_LINES_THRESHOLD + 1,
      changedBytes: 1,
    })).toBe('changed-lines');
    expect(singleFileTooLargeReason({
      changedLines: 1,
      changedBytes: SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
    })).toBeNull();
    expect(singleFileTooLargeReason({
      changedLines: 1,
      changedBytes: SINGLE_FILE_CHANGED_BYTES_THRESHOLD + 1,
    })).toBe('changed-bytes');
    expect(singleFileTooLargeReason({
      changedLines: 1,
      changedBytes: 1,
      maxLineBytes: SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD,
    })).toBeNull();
    expect(singleFileTooLargeReason({
      changedLines: 1,
      changedBytes: 1,
      maxLineBytes: SINGLE_FILE_MAX_LINE_BYTES_THRESHOLD + 1,
    })).toBe('max-line-bytes');
  });
});
