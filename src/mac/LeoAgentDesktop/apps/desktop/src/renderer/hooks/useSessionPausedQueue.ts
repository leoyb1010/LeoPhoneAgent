/**
 * useSessionPausedQueue — reactive "does this session have a paused, unsent queue?"
 * ---------------------------------------------------------------------------
 * Companion to `useComposerDraftPresence`: lets the sidebar's SessionItem show
 * its unsent-content indicator when a session has queued messages held back by
 * a paused queue (e.g. the user hit Stop with keepQueue), in addition to a
 * composer draft.
 *
 * Subscription source — why `subscribeAll`, not per-session `subscribe`:
 *   `makerChatStore` is an LRU cache (MAX_CACHED_SESSIONS). When an idle,
 *   non-viewed session is evicted, `_purgeSession` deletes that session's
 *   per-session entry from the `listeners` Map — so a `subscribe(sessionId)`
 *   callback would be silently dropped and the sidebar pencil would go stale
 *   (no notification fires to clear it). `globalListeners` is NOT touched by
 *   purge, and eviction happens inside a `setState` that fires a global notify,
 *   so a `subscribeAll` listener re-reads `hasPausedQueue(sessionId)` (now
 *   false for the evicted session) and clears the indicator. This mirrors how
 *   `useSessionRunningStatus` subscribes. (The draft hook can safely use a
 *   per-key subscription because `composerDraftStore` is never LRU-purged.)
 *
 * `hasPausedQueue` is a NON-creating read (no `getOrCreateState`), so querying
 * it per listed session never touches the LRU or materializes phantom state.
 * It returns a boolean primitive, so React bails out of re-render when the
 * value is unchanged (no spurious re-renders during streaming token churn).
 */

import { useCallback, useSyncExternalStore } from 'react';
import { makerChatStore } from '@/lib/makerChatStore';

/**
 * @returns `true` when `sessionId` currently has a paused, non-empty pending
 *          queue, `false` otherwise.
 */
export function useSessionPausedQueue(sessionId: string): boolean {
  const getSnapshot = useCallback(
    () => makerChatStore.hasPausedQueue(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(makerChatStore.subscribeAll, getSnapshot);
}
