import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import {
  markVoiceInputProviderFailure,
  markVoiceInputProviderSuccess,
} from './VoiceInputProviderHealth.js';
import type { VoiceInputProviderKind } from './voiceInputAsrConfig.js';

const log = createLogger('voice-input:asr-fallback');

// appendAudio() arriving before any candidate finished start() is buffered and
// replayed once a provider connects. The IPC audio path only pumps after
// controller.start() resolves, so this buffer is a safety net for in-process
// callers; the cap only guards against a pathological caller, at 100ms chunks
// it covers well over a minute of audio.
const MAX_PENDING_AUDIO_CHUNKS = 1_024;

export type FallbackAsrCandidate = {
  kind: VoiceInputProviderKind;
  /** Lazily constructs the underlying provider; only called when this candidate is attempted. */
  create: () => Promise<AsrProvider>;
};

/**
 * Connect-phase fallback wrapper around the configured ASR provider chain.
 *
 * `start()` walks the candidates in priority order: the first provider whose
 * `start()` resolves becomes the active provider for the whole dictation
 * session. Failed candidates are put into the sticky-failover cooldown (see
 * VoiceInputProviderHealth) so the next dictation skips ahead of them.
 *
 * Deliberately NOT covered (per design): mid-session hot switching. Once a
 * provider is active, a mid-stream transport failure follows the existing
 * single-provider `recover()` path; switching providers mid-dictation would
 * lose already-streamed audio and create transcript seams.
 */
export class FallbackAsrProvider implements AsrProvider {
  private readonly candidates: FallbackAsrCandidate[];
  private active: AsrProvider | null = null;
  private activeKind: VoiceInputProviderKind | null = null;
  private readonly eventCallbacks: Array<(event: AsrEvent) => void> = [];
  private readonly pendingAudio: Array<{ chunk: ArrayBuffer; trace?: AudioTrace }> = [];
  private pendingAudioOverflowWarned = false;
  private disposed = false;

  /**
   * Assigned in start() only when the committed provider itself supports
   * recovery. VoiceInputController feature-detects `typeof recover ===
   * 'function'`, so unconditionally exposing a method here would make the
   * controller attempt (and log) recovery on providers that cannot recover.
   */
  recover?: () => Promise<void>;

  constructor(candidates: FallbackAsrCandidate[]) {
    if (candidates.length === 0) {
      throw new Error('FallbackAsrProvider requires at least one ASR provider candidate.');
    }
    this.candidates = candidates;
  }

  /** Provider kind that actually connected; null until start() succeeds. */
  get activeProviderKind(): VoiceInputProviderKind | null {
    return this.activeKind;
  }

  async start(): Promise<void> {
    let lastError: unknown = null;
    const failures: Array<{
      kind: VoiceInputProviderKind;
      phase: 'create' | 'start';
      message: string;
      error: unknown;
    }> = [];
    for (const [index, candidate] of this.candidates.entries()) {
      // The host can dispose this wrapper while a candidate is still mid
      // connect (every `await` below is a suspension point). Re-check after
      // each one so a late-connecting candidate is shut down instead of
      // being committed as a leaked session nobody will ever stop.
      if (this.disposed) throw new Error('Voice input ASR fallback disposed during start.');
      let provider: AsrProvider;
      try {
        provider = await candidate.create();
      } catch (error) {
        lastError = error;
        failures.push(this.handleCandidateFailure(candidate.kind, index, 'create', error));
        continue;
      }
      if (this.disposed) {
        // Disposed while this candidate was being created: dispose it before
        // it ever dials, instead of letting start() open a doomed session.
        void provider.dispose?.().catch(() => undefined);
        throw new Error('Voice input ASR fallback disposed during start.');
      }
      // Events from a candidate are only forwarded while it is the committed
      // active provider. A failed start attempt may emit error/disconnected
      // events; leaking those to VoiceInputController would surface a user
      // visible failure even though the next candidate succeeds.
      provider.onEvent((event) => {
        if (this.active === provider) {
          for (const callback of this.eventCallbacks) callback(event);
        }
      });
      try {
        await provider.start();
      } catch (error) {
        lastError = error;
        failures.push(this.handleCandidateFailure(candidate.kind, index, 'start', error));
        void provider.dispose?.().catch((disposeError: unknown) => {
          log.debug('failed ASR candidate dispose error ignored', {
            provider: candidate.kind,
            error: disposeError instanceof Error ? disposeError.message : String(disposeError),
          });
        });
        continue;
      }
      if (this.disposed) {
        // Disposed while this candidate was connecting: do not commit it.
        void provider.stop().catch(() => undefined);
        void provider.dispose?.().catch(() => undefined);
        throw new Error('Voice input ASR fallback disposed during start.');
      }
      this.active = provider;
      this.activeKind = candidate.kind;
      this.recover = provider.recover
        ? () => this.recoverActiveProvider(provider, candidate.kind)
        : undefined;
      markVoiceInputProviderSuccess('asr', candidate.kind);
      if (index > 0) {
        log.info('asr fallback succeeded', {
          provider: candidate.kind,
          attempt: index + 1,
          skipped: this.candidates.slice(0, index).map((skipped) => skipped.kind),
        });
      }
      this.flushPendingAudio(provider);
      return;
    }
    // Aggregate every candidate's failure instead of surfacing only the last
    // one: a chain-wide outage (e.g. issue #220, gateway missing all ASR
    // passthrough routes) is undiagnosable from a single tail error. Keep the
    // original error object when only one candidate exists so callers see its
    // exact type/stack (e.g. missing-credential messages).
    if (failures.length <= 1) {
      throw lastError instanceof Error
        ? lastError
        : new Error('All voice input ASR providers failed to start.');
    }
    const details = failures
      .map((failure) => `[${failure.kind} ${failure.phase}] ${failure.message}`)
      .join('; ');
    // AggregateError keeps every original error object (stack, cause, e.g.
    // ECONNREFUSED / TLS details) reachable via `.errors` for logging and
    // telemetry, while `.message` stays the human-readable summary above.
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `All ${failures.length} voice input ASR providers failed to start: ${details}`,
    );
  }

  async stop(): Promise<void> {
    await this.active?.stop();
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (this.active) {
      this.active.appendAudio(chunk, trace);
      return;
    }
    if (this.pendingAudio.length >= MAX_PENDING_AUDIO_CHUNKS) {
      if (!this.pendingAudioOverflowWarned) {
        this.pendingAudioOverflowWarned = true;
        log.warn('pending audio buffer overflow before ASR connect, dropping oldest chunks');
      }
      this.pendingAudio.shift();
    }
    this.pendingAudio.push({ chunk, trace });
  }

  async flushAudio(): Promise<void> {
    if (!this.active) return;
    await this.active.flushAudio();
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  private async recoverActiveProvider(
    provider: AsrProvider,
    kind: VoiceInputProviderKind,
  ): Promise<void> {
    try {
      await provider.recover!();
    } catch (error) {
      // Recovery exhausted mid-session: the run ends as today, but the sticky
      // cooldown makes the NEXT dictation start from the following candidate.
      markVoiceInputProviderFailure(
        'asr',
        kind,
        `recover failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.active?.dispose?.();
  }

  private handleCandidateFailure(
    kind: VoiceInputProviderKind,
    index: number,
    phase: 'create' | 'start',
    error: unknown,
  ): { kind: VoiceInputProviderKind; phase: 'create' | 'start'; message: string; error: unknown } {
    const message = error instanceof Error ? error.message : String(error);
    markVoiceInputProviderFailure('asr', kind, `${phase} failed: ${message}`);
    log.warn('asr fallback candidate failed, trying next', {
      provider: kind,
      attempt: index + 1,
      totalCandidates: this.candidates.length,
      phase,
      error: message,
    });
    return { kind, phase, message, error };
  }

  private flushPendingAudio(provider: AsrProvider): void {
    for (const { chunk, trace } of this.pendingAudio) {
      provider.appendAudio(chunk, trace);
    }
    this.pendingAudio.length = 0;
  }
}
