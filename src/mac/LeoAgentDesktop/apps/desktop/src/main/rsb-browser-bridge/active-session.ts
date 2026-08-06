/**
 * active-session — module singleton tracking which RSB session is currently
 * active in the renderer.
 *
 * The MCP `browser` actions are sessionless — they expect "the current
 * session" semantics ("open a tab", "list tabs"). The renderer's RSB store is
 * per-session, so main needs to know which session is in focus right now to
 * dispatch a tab op against the right bucket.
 *
 * Renderer is authoritative: on Shell mount / session switch it pushes the
 * current sessionId via `rsb-browser-bridge:set-active-session`. Main reads
 * via `getActiveRsbSessionId()`; null = no RSB session in focus (e.g. user is
 * on a non-cc-agent route, or before the first Shell mount).
 *
 * The signal is a soft hint, not a synchronization primitive:
 *  - During session switch there is a window where main has the old sessionId
 *    but renderer has already moved on; backend actions race against this
 *    transparently (the worst case is "wrong session's tabs surfaced" — the
 *    backend ALWAYS validates targetId via the TabRegistry, which only
 *    contains tabs that genuinely belong to a reported sessionId, so no
 *    cross-session corruption).
 *  - Logout / app quit should clear via `setActiveRsbSessionId(null)` so a
 *    stale id doesn't leak into the next login.
 */

let activeSessionId: string | null = null;
const listeners = new Set<(sessionId: string | null) => void>();

export function setActiveRsbSessionId(sessionId: string | null): void {
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  for (const l of listeners) {
    try {
      l(sessionId);
    } catch {
      // Listener throws are swallowed — they shouldn't be load-bearing here.
    }
  }
}

export function getActiveRsbSessionId(): string | null {
  return activeSessionId;
}

export function onActiveRsbSessionIdChange(
  listener: (sessionId: string | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset. */
export function _resetActiveRsbSessionForTests(): void {
  activeSessionId = null;
  listeners.clear();
}
