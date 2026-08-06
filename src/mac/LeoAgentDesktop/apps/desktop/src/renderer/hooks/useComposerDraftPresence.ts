/**
 * useComposerDraftPresence — reactive "does this session have an unsent draft?"
 * ---------------------------------------------------------------------------
 * Lets the sidebar's SessionItem subscribe to a session's composer-draft
 * has-content boolean (text OR attachments) without owning the ChatInput.
 *
 * Backed by `composerDraftStore`'s presence channel, which fires only when the
 * boolean flips (empty↔non-empty) — so typing further into an already-non-empty
 * draft notifies nothing. `useSyncExternalStore` returns a boolean primitive,
 * so React bails out of re-render when the value is unchanged.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getDraftPresence,
  subscribeDraftPresence,
} from '@/lib/composerDraftStore';

/**
 * @returns `true` when `sessionId` currently has a non-empty composer draft
 *          (text or attachments), `false` otherwise.
 */
export function useComposerDraftPresence(sessionId: string): boolean {
  // Both args memoized on [sessionId] so subscribe/getSnapshot stay symmetric:
  // when sessionId changes, both recreate together and useSyncExternalStore
  // re-subscribes + reads the new session's presence in lockstep (no stale
  // read window). getSnapshot returns a boolean primitive → React bails out
  // when unchanged.
  const subscribe = useCallback(
    (cb: () => void) => subscribeDraftPresence(sessionId, cb),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getDraftPresence(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
