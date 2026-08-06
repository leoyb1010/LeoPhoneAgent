import { describe, expect, it } from 'vitest';

import { getRichMarkdownPreviewEligibility } from '../markdownPreview';

const baseDiff = {
  kind: 'text' as const,
  path: 'docs/readme.md',
  status: 'modified' as const,
  isBinary: false,
  isTooLarge: false,
};

describe('rich markdown preview eligibility', () => {
  it('allows markdown family extensions case-insensitively', () => {
    for (const path of ['README.md', 'guide.mdx', 'notes.markdown', 'a/b/file.mkd', 'draft.MDOWN']) {
      expect(getRichMarkdownPreviewEligibility({ ...baseDiff, path }, true)).toEqual({
        canPreview: true,
        reason: null,
      });
    }
  });

  it('blocks when the global toggle is disabled', () => {
    expect(getRichMarkdownPreviewEligibility(baseDiff, false)).toEqual({
      canPreview: false,
      reason: 'disabled',
    });
  });

  it('blocks non-markdown, deleted, binary, and too-large diffs', () => {
    expect(getRichMarkdownPreviewEligibility({ ...baseDiff, path: 'src/readme.txt' }, true).reason).toBe('not-markdown');
    expect(getRichMarkdownPreviewEligibility({ ...baseDiff, status: 'deleted' }, true).reason).toBe('deleted');
    expect(getRichMarkdownPreviewEligibility({ ...baseDiff, kind: 'binary' as const, isBinary: true }, true).reason).toBe('unsupported-kind');
    expect(getRichMarkdownPreviewEligibility({ ...baseDiff, kind: 'large-text' as const }, true).reason).toBe('too-large');
    expect(getRichMarkdownPreviewEligibility({ ...baseDiff, isTooLarge: true }, true).reason).toBe('too-large');
  });
});
