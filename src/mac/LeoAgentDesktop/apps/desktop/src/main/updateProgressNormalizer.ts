/**
 * updateProgressNormalizer — AU-M2 (caller-side progress normalization).
 * ---------------------------------------------------------------------------
 * Caller-side progress normalization contract.
 *
 * The unified-downloader emits RAW progress events (loaded, total, percent —
 * any of which may be null / out of range / jittery on resume). The renderer
 * needs a stable 0-100 integer that never goes backwards.
 *
 * This class lives on the caller side (UpdateService / ccdManager) and:
 *   1. Clamps the raw percent into [0, 100].
 *   2. Enforces monotonic non-decreasing — a late event that would lower the
 *      bar is silently dropped.
 *   3. Throttles IPC pushes to ≤ 5/sec (200 ms gap), with one exception:
 *      reaching 100 always emits immediately.
 *   4. Estimates a pseudo-progress when total is unknown (log10 curve, capped
 *      at 95% so the user knows the file isn't fully verified yet).
 *
 * History note: this anti-rollback layer is the second half of fixing the
 * "progress bar bounces back to 0" regression — without it, a SHA256 retry
 * (which legitimately resets `loaded` for a new attempt) would visually
 * collapse the bar mid-download.
 */

import type { ProgressEvent } from './downloader/index';

const IPC_THROTTLE_MS = 200;

export interface ProgressNormalizerOptions {
  /** Push the (already-clamped, monotonic) percent to the renderer. */
  onIpc: (progress: number) => void;
}

export class ProgressNormalizer {
  private lastEmittedProgress = 0;
  private lastEmitAt = 0;
  private readonly onIpc: (progress: number) => void;

  constructor(opts: ProgressNormalizerOptions) {
    this.onIpc = opts.onIpc;
  }

  handle(e: ProgressEvent): void {
    let raw: number;
    if (e.percent !== null && Number.isFinite(e.percent)) {
      raw = e.percent;
    } else {
      // total unknown — log10 estimate capped at 95
      const mb = e.loaded / (1024 * 1024);
      raw = Math.min(95, Math.log10(mb + 1) * 30);
    }

    // 1. Clamp to integer 0-100.
    const clamped = Math.max(0, Math.min(100, Math.round(raw)));

    // 2. Anti-rollback (monotonic).
    const next = Math.max(this.lastEmittedProgress, clamped);

    // 3. Throttle (with 100% override).
    const now = Date.now();
    const goingUp = next > this.lastEmittedProgress;
    const reached100 = next === 100 && this.lastEmittedProgress < 100;
    if (!goingUp && !reached100) return;
    if (reached100 || now - this.lastEmitAt >= IPC_THROTTLE_MS) {
      this.lastEmittedProgress = next;
      this.lastEmitAt = now;
      this.onIpc(next);
    } else {
      // Within throttle window — bump last value but don't push.
      // Next emit will use the higher value (still monotonic).
      this.lastEmittedProgress = next;
    }
  }

  /** Force-push the current best value (e.g. before announcing "ready"). */
  flush(): void {
    this.lastEmitAt = Date.now();
    this.onIpc(this.lastEmittedProgress);
  }

  /** Read-only accessor for tests / diagnostics. */
  getCurrent(): number {
    return this.lastEmittedProgress;
  }
}
