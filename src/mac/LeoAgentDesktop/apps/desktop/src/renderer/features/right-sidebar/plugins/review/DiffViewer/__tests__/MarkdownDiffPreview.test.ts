// @vitest-environment jsdom

import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileDiff, ReviewMarkdownPreviewData } from '@/lib/gitReview.types';

const markdownRendererMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content: string; allowPrivilegedLinks?: boolean }) => {
    markdownRendererMock(props);
    return props.content;
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { MarkdownDiffPreview } from '../MarkdownDiffPreview';

function diff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'unstaged:docs/readme.md',
    source: 'unstaged',
    path: 'docs/readme.md',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 10,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
    ...overrides,
  };
}

describe('MarkdownDiffPreview', () => {
  it('renders untrusted repository markdown with privileged links disabled', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: '# Preview',
      size: 9,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    render(createElement(MarkdownDiffPreview, {
      diff: diff(),
      loadMarkdownPreview: vi.fn(async () => data),
      fallback: createElement('div', null, 'fallback'),
    }));

    await screen.findByText('# Preview');
    await waitFor(() => {
      expect(markdownRendererMock).toHaveBeenCalledWith(expect.objectContaining({
        allowPrivilegedLinks: false,
        content: '# Preview',
        workingDir: '/repo/docs',
      }));
    });
  });
});
