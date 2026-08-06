// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewCommitDiffData, ReviewDirtySummary, ReviewFileDiffData, ReviewFileDiffRequest } from '@/lib/gitReview.types';
import { useReviewCommitDiff, useReviewDirtySummary, useReviewFileDiff, useReviewFileDiffs } from '../useReviewGitState';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe({ sessionId, oid }: { sessionId: string; oid: string }) {
  const state = useReviewCommitDiff(sessionId, oid);
  return createElement('div', { 'data-testid': 'state' }, `${state.data?.commitOid ?? 'null'}|${state.loading ? 'loading' : 'idle'}`);
}

function SummaryProbe({ sessionId }: { sessionId: string | null }) {
  const state = useReviewDirtySummary(sessionId);
  return createElement('div', { 'data-testid': 'state' }, `${state.data?.sessionId ?? 'null'}|${state.loading ? 'loading' : 'idle'}`);
}

function FileDiffProbe({
  sessionId,
  request,
  refreshVersion,
}: {
  sessionId: string;
  request: ReviewFileDiffRequest;
  refreshVersion: number;
}) {
  const state = useReviewFileDiff(sessionId, request, refreshVersion);
  return createElement('div', { 'data-testid': 'state' }, `${state.data?.diff?.path ?? 'null'}|${state.loading ? 'loading' : 'idle'}`);
}

function FileDiffsProbe({
  sessionId,
  requests,
}: {
  sessionId: string;
  requests: readonly ReviewFileDiffRequest[];
}) {
  const state = useReviewFileDiffs(sessionId, requests);
  return createElement('div', { 'data-testid': 'state' }, `${state.data?.length ?? 0}|${state.loading ? 'loading' : 'idle'}`);
}

function commitDiffData(commitOid: string): ReviewCommitDiffData {
  return {
    scope: {} as ReviewCommitDiffData['scope'],
    commitOid,
    diffs: [],
    capped: null,
  };
}

function dirtySummary(sessionId: string): ReviewDirtySummary {
  return {
    sessionId,
    disabledReason: null,
    disabledMessage: null,
    totalFiles: 1,
    stagedFiles: 0,
    unstagedFiles: 1,
    untrackedFiles: 0,
    unmergedFiles: 0,
    dirty: true,
  };
}

function fileDiffData(path: string): ReviewFileDiffData {
  return {
    scope: {} as ReviewFileDiffData['scope'],
    diff: {
      id: `unstaged:${path}`,
      source: 'unstaged',
      path,
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
    },
  };
}

describe('useReviewGitState cache continuity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps previous data while loading an uncached commit diff key', async () => {
    const pendingNext = deferred<ReviewCommitDiffData>();
    const commitDiff = vi.fn((payload: { oid: string }) => {
      if (payload.oid === 'commit-a') {
        return Promise.resolve(commitDiffData('commit-a'));
      }
      return pendingNext.promise;
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { commitDiff },
    };

    const { rerender } = render(createElement(Probe, { sessionId: 'cache-continuity-session', oid: 'commit-a' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-a|idle'));

    rerender(createElement(Probe, { sessionId: 'cache-continuity-session', oid: 'commit-b' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-a|loading'));

    await act(async () => {
      pendingNext.resolve(commitDiffData('commit-b'));
      await pendingNext.promise;
    });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-b|idle'));
  });

  it('does not write back an in-flight request after the session is disabled', async () => {
    const pending = deferred<ReviewDirtySummary>();
    const summary = vi.fn(() => pending.promise);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { summary },
    };

    const { rerender } = render(createElement(SummaryProbe, { sessionId: 'summary-session' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('null|loading'));

    rerender(createElement(SummaryProbe, { sessionId: null }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('null|idle'));

    await act(async () => {
      pending.resolve(dirtySummary('summary-session'));
      await pending.promise;
    });
    expect(screen.getByTestId('state').textContent).toBe('null|idle');
  });

  it('reloads a file diff when the write refresh version changes without changing the IPC payload', async () => {
    const fileDiff = vi.fn(async () => fileDiffData('src/a.ts'));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { fileDiff },
    };
    const request: ReviewFileDiffRequest = {
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    };

    const { rerender } = render(createElement(FileDiffProbe, {
      sessionId: 'file-diff-write-version-session',
      request,
      refreshVersion: 0,
    }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('src/a.ts|idle'));
    expect(fileDiff).toHaveBeenCalledTimes(1);

    rerender(createElement(FileDiffProbe, {
      sessionId: 'file-diff-write-version-session',
      request,
      refreshVersion: 1,
    }));

    await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(2));
    expect(fileDiff).toHaveBeenLastCalledWith({
      sessionId: 'file-diff-write-version-session',
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    });
  });

  it('does not reload a file diff batch when request array identity changes without content changes', async () => {
    const fileDiff = vi.fn(async (payload: ReviewFileDiffRequest & { sessionId: string }) => fileDiffData(payload.path));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { fileDiff },
    };
    const request: ReviewFileDiffRequest = {
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    };

    const { rerender } = render(createElement(FileDiffsProbe, {
      sessionId: 'file-diff-batch-session',
      requests: [{ ...request }],
    }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('1|idle'));
    expect(fileDiff).toHaveBeenCalledTimes(1);

    rerender(createElement(FileDiffsProbe, {
      sessionId: 'file-diff-batch-session',
      requests: [{ ...request }],
    }));

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fileDiff).toHaveBeenCalledTimes(1);
  });
});
