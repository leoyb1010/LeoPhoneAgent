import { describe, expect, it } from 'vitest';

import {
  getVisibleFileContentState,
  type FileContentState,
} from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import {
  clearFileScroll,
  loadFileScroll,
  saveFileScroll,
} from '@/features/cc-agent/workdir-browse/lib/fileScrollStore';
import {
  buildNormalFileSelectionParams,
  clearConsumedSearchJumpParams,
  shouldConsumeStaleSearchJump,
} from '@/features/cc-agent/workdir-browse/lib/fileSelectionParams';

describe('workdir browse file content state', () => {
  it('does not expose stale text content after the selected relPath changes', () => {
    const state: FileContentState = {
      workdir: '/repo',
      relPath: 'docs/a.md',
      content: {
        kind: 'text',
        relPath: 'docs/a.md',
        content: '# A',
        size: 3,
        mtimeMs: 1,
        truncated: false,
      },
    };

    expect(getVisibleFileContentState(state, '/repo', 'docs/b.md')).toEqual({
      kind: 'loading',
    });
  });

  it('keeps current-file content visible for save-after local updates', () => {
    const state: FileContentState = {
      workdir: '/repo',
      relPath: 'docs/a.md',
      content: {
        kind: 'text',
        relPath: 'docs/a.md',
        content: '# A updated',
        size: 11,
        mtimeMs: 2,
        truncated: false,
      },
    };

    expect(getVisibleFileContentState(state, '/repo', 'docs/a.md')).toEqual(
      state.content,
    );
  });

  it('hides content from a previous workdir even when relPath matches', () => {
    const state: FileContentState = {
      workdir: '/old-repo',
      relPath: 'README.md',
      content: {
        kind: 'text',
        relPath: 'README.md',
        content: 'old',
        size: 3,
        mtimeMs: 1,
        truncated: false,
      },
    };

    expect(getVisibleFileContentState(state, '/repo', 'README.md')).toEqual({
      kind: 'loading',
    });
  });
});

describe('workdir browse file scroll state', () => {
  it('persists pixel, line, and in-block offset anchors per file', () => {
    saveFileScroll('/repo-scroll', 'docs/a.md', {
      top: 1024,
      line: 42,
      offset: 128,
    });

    expect(loadFileScroll('/repo-scroll', 'docs/a.md')).toEqual({
      top: 1024,
      line: 42,
      offset: 128,
    });
    expect(loadFileScroll('/repo-scroll', 'docs/b.md')).toBeNull();
  });

  it('clears a file anchor when the document tab is closed', () => {
    saveFileScroll('/repo-scroll-close', 'docs/a.md', {
      top: 2048,
      line: 80,
      offset: 256,
    });

    clearFileScroll('/repo-scroll-close', 'docs/a.md');

    expect(loadFileScroll('/repo-scroll-close', 'docs/a.md')).toBeNull();
  });
});

describe('workdir browse file selection params', () => {
  it('clears one-shot project-search jump params on normal file selection', () => {
    const prev = new URLSearchParams({
      file: 'docs/from-search.md',
      search: 'needle',
      line: '80',
      other: 'kept',
    });

    const next = buildNormalFileSelectionParams(prev, 'docs/normal.md');

    expect(next.get('file')).toBe('docs/normal.md');
    expect(next.has('search')).toBe(false);
    expect(next.has('line')).toBe(false);
    expect(next.get('other')).toBe('kept');
  });

  it('clears consumed one-shot project-search jump params without changing the selected file', () => {
    const prev = new URLSearchParams({
      file: 'docs/current.md',
      search: 'needle',
      line: '80',
      other: 'kept',
    });

    const next = clearConsumedSearchJumpParams(prev);

    expect(next.get('file')).toBe('docs/current.md');
    expect(next.has('search')).toBe(false);
    expect(next.has('line')).toBe(false);
    expect(next.get('other')).toBe('kept');
  });
});

describe('workdir browse project-search jumps', () => {
  it('consumes stale project-search jumps only after the target query scanned with zero matches', () => {
    expect(shouldConsumeStaleSearchJump(null, 'needle')).toBe(false);
    expect(shouldConsumeStaleSearchJump({ query: 'other', total: 0 }, 'needle')).toBe(false);
    expect(shouldConsumeStaleSearchJump({ query: 'needle', total: 1 }, 'needle')).toBe(false);
    expect(shouldConsumeStaleSearchJump({ query: 'needle', total: 0 }, 'needle')).toBe(true);
  });
});
