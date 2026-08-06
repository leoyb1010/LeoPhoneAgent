/**
 * idleManager.ts
 * ---------------------------------------------------------------------------
 * Aligned with Claude Desktop's IdleManager (V0t class).
 *
 * Tracks per-session idle state. When a session's turn completes and the
 * session is not visible (user switched to another tab/session), an idle
 * timer starts. After `idleTimeoutMs` of inactivity the `onDisconnect`
 * callback fires (which pauses the session — teardown query but keep
 * metadata). When the session becomes visible again, `onWarmUp` fires
 * (which rebuilds the query with `resume`).
 *
 * Key constants (aligned with Desktop):
 *   - Default idle timeout: 15 minutes (900_000 ms)
 *   - Activity during idle window extends the timer by the remaining time
 */

import { createLogger } from './logger';

const log = createLogger('idleManager');

// We intentionally do NOT log onActivity (called on every stderr line, would
// flood the log). Coverage targets visibility / lifecycle events that matter
// when a session "looks paused" but you can't tell why. devLog uses
// `log.debug` — packaged (default info) stays quiet, dev (trace) sees it.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleSessionState {
  sessionId: string;
  /** Whether this session's tab/view is currently visible to the user. */
  isTabVisible: boolean;
  /** True once a turn completes and we're waiting before pausing. */
  hasPendingResult: boolean;
  /** Timestamp of the last turn completion. */
  lastResultTime: number | null;
  /** Timestamp of any activity (message sent, stderr, etc.) during idle window. */
  lastActivityTime: number | null;
  /** Handle for the idle timeout timer. */
  idleTimeoutId: ReturnType<typeof setTimeout> | null;
  /** True while warmSession is in progress (prevents double warm). */
  isWarmingUp: boolean;
}

export interface IdleManagerConfig {
  /** Display name for logging. */
  name?: string;
  /** How long a session can be idle (hidden + no activity) before pausing. Default: 15 min. */
  idleTimeoutMs?: number;
  /** Called when a session should be paused (teardown query). */
  onDisconnect: (sessionId: string) => Promise<void> | void;
  /** Called when a paused session should be warmed (rebuild query with resume). */
  onWarmUp: (sessionId: string) => Promise<void>;
  /** Returns true if the session currently has an active query. */
  hasActiveQuery: (sessionId: string) => boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 900_000; // 15 minutes

// ---------------------------------------------------------------------------
// IdleManager
// ---------------------------------------------------------------------------

export class IdleManager {
  private sessions = new Map<string, IdleSessionState>();
  private config: Required<Omit<IdleManagerConfig, 'name'>> & { name: string };
  private tag: string;

  constructor(config: IdleManagerConfig) {
    const name = config.name ?? 'session';
    this.tag = `[IdleManager:${name}]`;
    this.config = {
      name,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      onDisconnect: config.onDisconnect,
      onWarmUp: config.onWarmUp,
      hasActiveQuery: config.hasActiveQuery,
    };
    log.info(`${this.tag} Initialized with ${this.config.idleTimeoutMs / 1000}s timeout`);
  }

  /**
   * Session-scoped trace. Same prefix shape as agentManager.devLog so a mixed
   * grep of `[IdleManager` + `[agentManager dev]` shows the full pause/warm
   * story interleaved with the SDK message stream.
   */
  private devLog(action: string, sessionId?: string, detail?: unknown): void {
    const sid = sessionId ? ` [${sessionId.slice(0, 8)}]` : '';
    if (detail !== undefined) {
      log.debug(`${this.tag} dev${sid} ${action}`, detail);
    } else {
      log.debug(`${this.tag} dev${sid} ${action}`);
    }
  }

  // ── Registration ──

  registerSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        isTabVisible: true,
        hasPendingResult: false,
        lastResultTime: null,
        lastActivityTime: null,
        idleTimeoutId: null,
        isWarmingUp: false,
      });
      this.devLog(`register (initial visible=true)`, sessionId);
    }
  }

  unregisterSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.idleTimeoutId) {
      this.devLog(`unregister (clearing pending idle timeout)`, sessionId);
      clearTimeout(state.idleTimeoutId);
    } else if (state) {
      this.devLog(`unregister`, sessionId);
    }
    this.sessions.delete(sessionId);
  }

  // ── Activity signals ──

  /** Called when a turn completes (result message received). */
  onTurnComplete(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.hasPendingResult = true;
    state.lastResultTime = Date.now();
    this.devLog(`onTurnComplete (visible=${state.isTabVisible}${state.isTabVisible ? ', skipping idle timer' : ', will start idle timer'})`, sessionId);
    // Only start idle timeout if session is not visible
    if (!state.isTabVisible) {
      this.startIdleTimeout(sessionId);
    }
  }

  /** Called when any activity happens (stderr, message processing, etc.). */
  onActivity(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.lastActivityTime = Date.now();
    }
  }

  /** Called when the user sends a message. Cancels any pending idle timeout. */
  onMessageSent(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.idleTimeoutId) {
      this.devLog(`onMessageSent (cancelling pending idle timeout)`, sessionId);
    }
    this.clearIdleTimeout(sessionId);
    state.hasPendingResult = false;
    state.lastResultTime = null;
  }

  /**
   * Called when the user switches to/from this session.
   * - visible=true → cancel idle timeout, warm if needed
   * - visible=false → start idle timeout if turn already completed
   */
  onVisibilityChange(sessionId: string, visible: boolean): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    const wasVisible = state.isTabVisible;
    state.isTabVisible = visible;

    if (wasVisible !== visible) {
      this.devLog(`onVisibilityChange ${wasVisible} -> ${visible}`, sessionId);
    }

    if (visible && !wasVisible) {
      // Session became visible → cancel idle timeout, warm if paused
      this.clearIdleTimeout(sessionId);
      const hasQuery = this.config.hasActiveQuery(sessionId);
      if (!hasQuery && !state.isWarmingUp) {
        state.isWarmingUp = true;
        this.devLog(`triggering warm (no active query)`, sessionId);
        log.debug(`${this.tag} Warming session ${sessionId}`);
        this.config.onWarmUp(sessionId)
          .catch((err) => log.error(`${this.tag} Failed to warm ${sessionId}:`, err))
          .finally(() => {
            state.isWarmingUp = false;
            this.devLog(`warm finished`, sessionId);
          });
      } else {
        this.devLog(`became visible (hasQuery=${hasQuery}, isWarmingUp=${state.isWarmingUp}, no warm needed)`, sessionId);
      }
    } else if (!visible && wasVisible) {
      // Session became hidden → start idle timer if turn already completed
      if (state.hasPendingResult) {
        this.devLog(`became hidden with pending result -> start idle timer`, sessionId);
        this.startIdleTimeout(sessionId);
      } else {
        this.devLog(`became hidden (no pending result, no idle timer)`, sessionId);
      }
    }
  }

  // ── Queries ──

  getState(sessionId: string): IdleSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getTimeoutMs(): number {
    return this.config.idleTimeoutMs;
  }

  // ── Cleanup ──

  destroy(): void {
    for (const [, state] of this.sessions) {
      if (state.idleTimeoutId) clearTimeout(state.idleTimeoutId);
    }
    this.sessions.clear();
    log.info(`${this.tag} Destroyed`);
  }

  // ── Internal ──

  private startIdleTimeout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    this.clearIdleTimeout(sessionId);

    if (!this.config.hasActiveQuery(sessionId)) return; // already disconnected

    const ms = this.config.idleTimeoutMs;
    log.debug(`${this.tag} Starting idle timeout for ${sessionId}: ${ms / 1000}s`);

    state.lastActivityTime = null;
    this.scheduleIdleTimeout(state, ms);
  }

  private scheduleIdleTimeout(state: IdleSessionState, ms: number): void {
    const { sessionId } = state;

    state.idleTimeoutId = setTimeout(async () => {
      state.idleTimeoutId = null;

      // Tab became visible in the meantime → abort
      if (state.isTabVisible) {
        this.devLog(`idle timer fired but tab now visible -> abort`, sessionId);
        return;
      }

      // Already disconnected → no-op
      if (!this.config.hasActiveQuery(sessionId)) {
        this.devLog(`idle timer fired but no active query -> no-op`, sessionId);
        return;
      }

      // Activity happened during the idle window → reschedule with remaining time
      if (state.lastActivityTime !== null) {
        const remaining = this.config.idleTimeoutMs - (Date.now() - state.lastActivityTime);
        state.lastActivityTime = null;
        if (remaining > 0) {
          log.debug(`${this.tag} Activity during idle window for ${sessionId}, extending ${Math.round(remaining / 1000)}s`);
          this.scheduleIdleTimeout(state, remaining);
          return;
        }
      }

      // Idle timeout reached — disconnect
      log.debug(`${this.tag} Idle timeout reached, disconnecting ${sessionId}`);
      this.devLog(`disconnecting (calling onDisconnect → pauseSession)`, sessionId);
      try {
        await this.config.onDisconnect(sessionId);
        this.devLog(`disconnect complete`, sessionId);
      } catch (err) {
        log.error(`${this.tag} Failed to disconnect ${sessionId}:`, err);
      }

      state.hasPendingResult = false;
    }, ms);
  }

  private clearIdleTimeout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.idleTimeoutId) {
      clearTimeout(state.idleTimeoutId);
      state.idleTimeoutId = null;
    }
  }
}
