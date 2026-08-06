/**
 * Hooks for git-review read state.
 *
 * Refresh triggers are explicit refresh, window focus, and makerChatStore
 * updates for the current session (debounced; covers turn-end changes).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import type {
  ReviewBranchDiffData,
  ReviewCommitDiffData,
  ReviewCommitListData,
  ReviewData,
  ReviewDirtySummary,
  ReviewFileDiffData,
  ReviewFileDiffRequest,
} from '@/lib/gitReview.types';
import { extractIpcError } from '@/utils/ipcError';
import { LruCache } from './DiffViewer/highlight';

const log = createLogger('rightSidebar.review.git');
const REFRESH_DEBOUNCE_MS = 350;
const FILE_DIFF_BATCH_CONCURRENCY = 6;
const reviewLoadCache = new LruCache<string, unknown>(20);

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setData: (data: T) => void;
}

function messageFromError(err: unknown): string {
  return extractIpcError(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

function useDebouncedCallback(cb: () => void, delayMs: number): () => void {
  const timerRef = useRef<number | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  return useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      cbRef.current();
    }, delayMs);
  }, [delayMs]);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      out[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function useGitReviewLoad<T>(
  sessionId: string | null,
  fetch: (sessionId: string) => Promise<T>,
  logLabel: string,
  options: { cacheKey?: string | null; preserveWhenDisabled?: boolean } = {},
): LoadState<T> {
  const cacheKey = options.cacheKey ?? null;
  const preserveWhenDisabled = options.preserveWhenDisabled ?? false;
  const [data, setDataState] = useState<T | null>(() => {
    const cached = cacheKey ? reviewLoadCache.get(cacheKey) as T | undefined : undefined;
    return cached ?? null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const setData = useCallback((next: T) => {
    setDataState(next);
    if (cacheKey) reviewLoadCache.set(cacheKey, next);
  }, [cacheKey]);

  const load = useCallback(() => {
    if (!sessionId) {
      requestRef.current += 1;
      if (!preserveWhenDisabled) setDataState(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    fetch(sessionId)
      .then((next) => {
        if (requestRef.current !== requestId) return;
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        const message = messageFromError(err);
        setError(message);
        log.warn(logLabel, { sessionId, message });
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [sessionId, fetch, logLabel, preserveWhenDisabled, setData]);
  const debouncedLoad = useDebouncedCallback(load, REFRESH_DEBOUNCE_MS);

  useEffect(() => {
    const cached = cacheKey ? reviewLoadCache.get(cacheKey) as T | undefined : undefined;
    if (cached !== undefined) {
      setDataState(cached);
    } else if (!sessionId && !preserveWhenDisabled) {
      setDataState(null);
    }
  }, [cacheKey, preserveWhenDisabled, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!sessionId) return;
    const onFocus = () => debouncedLoad();
    window.addEventListener('focus', onFocus);
    const unsubscribe = makerChatStore.subscribe(sessionId, debouncedLoad);
    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [sessionId, debouncedLoad]);

  return { data, loading, error, refresh: load, setData };
}

const fetchReviewSummary = (sessionId: string): Promise<ReviewDirtySummary> =>
  window.electronAPI.gitReview.summary({ sessionId });

export function useReviewGitState(
  sessionId: string | null,
  ignoreWhitespace = false,
): LoadState<ReviewData> {
  const fetchReviewData = useCallback((currentSessionId: string) =>
    window.electronAPI.gitReview.get({ sessionId: currentSessionId, ignoreWhitespace }), [ignoreWhitespace]);
  return useGitReviewLoad(sessionId, fetchReviewData, 'git review load failed', {
    cacheKey: sessionId ? `worktree:${sessionId}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
  });
}

export function useReviewDirtySummary(sessionId: string | null): LoadState<ReviewDirtySummary> {
  return useGitReviewLoad(sessionId, fetchReviewSummary, 'git review summary failed');
}

export function useReviewCommits(sessionId: string | null, baseRef: string | null): LoadState<ReviewCommitListData> {
  const fetchReviewCommits = useCallback((currentSessionId: string) =>
    window.electronAPI.gitReview.commits({ sessionId: currentSessionId, baseRef }), [baseRef]);
  return useGitReviewLoad(sessionId, fetchReviewCommits, 'git review commits failed');
}

export function useReviewCommitDiff(
  sessionId: string | null,
  oid: string | null,
  ignoreWhitespace = false,
): LoadState<ReviewCommitDiffData> {
  const fetchCommitDiff = useCallback((currentSessionId: string) => {
    if (!oid) return Promise.reject(new Error('commit oid is required'));
    return window.electronAPI.gitReview.commitDiff({ sessionId: currentSessionId, oid, ignoreWhitespace });
  }, [ignoreWhitespace, oid]);
  return useGitReviewLoad(sessionId && oid ? sessionId : null, fetchCommitDiff, 'git review commit diff failed', {
    cacheKey: sessionId && oid ? `commit:${sessionId}:${oid}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
    preserveWhenDisabled: true,
  });
}

export function useReviewBranchDiff(
  sessionId: string | null,
  baseRef: string | null,
  ignoreWhitespace = false,
  enabled = true,
): LoadState<ReviewBranchDiffData> {
  const fetchBranchDiff = useCallback((currentSessionId: string) =>
    window.electronAPI.gitReview.branchDiff({
      sessionId: currentSessionId,
      baseRef,
      ignoreWhitespace,
    }), [baseRef, ignoreWhitespace]);
  return useGitReviewLoad(sessionId && enabled ? sessionId : null, fetchBranchDiff, 'git review branch diff failed', {
    cacheKey: sessionId ? `branch:${sessionId}:${baseRef ?? 'default'}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
    preserveWhenDisabled: true,
  });
}

export function useReviewFileDiff(
  sessionId: string | null,
  request: ReviewFileDiffRequest | null,
  refreshVersion = 0,
): LoadState<ReviewFileDiffData> {
  const source = request?.source ?? null;
  const path = request?.path ?? null;
  const oldPath = request?.oldPath ?? null;
  const commitOid = request?.commitOid ?? null;
  const branchBaseRef = request?.branchBaseRef ?? null;
  const ignoreWhitespace = request?.ignoreWhitespace === true;
  const fetchFileDiff = useCallback((currentSessionId: string) => {
    if (!source || !path) return Promise.reject(new Error('file diff request is required'));
    return window.electronAPI.gitReview.fileDiff({
      sessionId: currentSessionId,
      source,
      path,
      oldPath,
      commitOid,
      branchBaseRef,
      ignoreWhitespace,
    });
  }, [branchBaseRef, commitOid, ignoreWhitespace, oldPath, path, refreshVersion, source]);
  const cacheKey = sessionId && source && path
    ? `file:${sessionId}:${source}:${commitOid ?? branchBaseRef ?? 'worktree'}:${oldPath ?? ''}:${path}:${ignoreWhitespace ? 'w' : 'plain'}:${refreshVersion}`
    : null;
  return useGitReviewLoad(sessionId && source && path ? sessionId : null, fetchFileDiff, 'git review file diff failed', {
    cacheKey,
    preserveWhenDisabled: true,
  });
}

export function useReviewFileDiffs(
  sessionId: string | null,
  requests: readonly ReviewFileDiffRequest[],
): LoadState<ReviewFileDiffData[]> {
  const requestKey = requests.length > 0
    ? JSON.stringify(requests.map((request) => ({
      source: request.source,
      path: request.path,
      oldPath: request.oldPath ?? null,
      commitOid: request.commitOid ?? null,
      branchBaseRef: request.branchBaseRef ?? null,
      ignoreWhitespace: request.ignoreWhitespace === true,
    })))
    : null;
  // React exhaustive-deps note: requestKey encodes request contents; array identity changes alone should not reload the batch.
  const fetchFileDiffs = useCallback((currentSessionId: string) =>
    mapWithConcurrency(requests, FILE_DIFF_BATCH_CONCURRENCY, (request) =>
      window.electronAPI.gitReview.fileDiff({
        sessionId: currentSessionId,
        source: request.source,
        path: request.path,
        oldPath: request.oldPath ?? null,
        commitOid: request.commitOid ?? null,
        branchBaseRef: request.branchBaseRef ?? null,
        ignoreWhitespace: request.ignoreWhitespace === true,
      })), [requestKey]);
  return useGitReviewLoad(
    sessionId && requestKey ? sessionId : null,
    fetchFileDiffs,
    'git review file diff batch failed',
    {
      cacheKey: sessionId && requestKey ? `files:${sessionId}:${requestKey}` : null,
      preserveWhenDisabled: false,
    },
  );
}
