import type { TextModelClient } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { describeErrorWithCause, isRefinerModelOutputError } from './refinerErrorKind.js';
import {
  markVoiceInputProviderFailure,
  markVoiceInputProviderSuccess,
  orderVoiceInputProvidersByHealth,
} from './VoiceInputProviderHealth.js';
import type { VoiceInputRefinerProviderKind } from '../../shared/voiceInputRefinerProfiles.js';

const log = createLogger('voice-input:refine-fallback');

// Refinement is a user-waiting path: with a 4s idle watchdog per attempt
// (see VOICE_INPUT_REFINER_IDLE_TIMEOUT_MS in index.ts), two attempts bound
// the worst case at ~8s before VoiceInputController falls back to the raw ASR
// text that is already on screen.
const MAX_REFINE_FALLBACK_ATTEMPTS = 2;

export type FallbackTextModelAttempt = {
  profileId: VoiceInputRefinerProviderKind;
  /** Model string sent for this attempt; overrides whatever the caller passed. */
  model: string;
  client: TextModelClient;
  /**
   * Per-profile prompt cache scope. When set it replaces the caller's scope so
   * cache keys never mix across providers; left undefined when the caller
   * supplied a custom scope that should flow through unchanged.
   */
  promptCacheScope?: string;
};

/**
 * Transport-level fallback wrapper around the refiner provider chain.
 *
 * Failure handling is classified (see refinerErrorKind.ts):
 * - Transport failures (network error, idle timeout, HTTP error, auth
 *   failure) → try the next model AND put the provider into sticky-failover
 *   cooldown: the channel itself is unhealthy.
 * - Model-output failures (malformed JSON / empty content) → still try the
 *   next model to rescue the current refinement, but WITHOUT cooldown: one
 *   bad generation does not make the provider unhealthy.
 * - Quality rejections (output identical to input / empty text field) are
 *   decided above in DictationRefiner and never throw, so they intentionally
 *   do not trigger a model switch — retrying a legitimate "no change" verdict
 *   on another model would only add latency.
 *
 * Once an attempt has streamed its first partial snapshot the failover window
 * is closed: refinement partials are optimistically applied to the UI, and
 * restarting on another model would visually rewind already-shown text.
 */
export class FallbackTextModelClient implements TextModelClient {
  private readonly attempts: FallbackTextModelAttempt[];

  constructor(attempts: FallbackTextModelAttempt[]) {
    if (attempts.length === 0) {
      throw new Error('FallbackTextModelClient requires at least one refiner attempt.');
    }
    this.attempts = attempts;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    // Sticky failover: providers in cooldown sort behind healthy ones, so a
    // refiner that just timed out does not cost every subsequent dictation a
    // full idle-timeout wait before the backup kicks in.
    const orderedIds = orderVoiceInputProvidersByHealth(
      'refiner',
      this.attempts.map((attempt) => attempt.profileId),
    );
    const ordered = orderedIds
      .map((profileId) => this.attempts.find((attempt) => attempt.profileId === profileId)!)
      .slice(0, MAX_REFINE_FALLBACK_ATTEMPTS);
    log.debug('refine fallback effective attempts', {
      attempts: ordered.map((attempt) => ({
        profileId: attempt.profileId,
        model: attempt.model,
      })),
      configuredAttempts: this.attempts.map((attempt) => attempt.profileId),
      maxAttempts: MAX_REFINE_FALLBACK_ATTEMPTS,
    });

    let lastError: unknown = null;
    for (const [index, attempt] of ordered.entries()) {
      let partialEmitted = false;
      try {
        const result = await attempt.client.requestJson<T>({
          ...input,
          model: attempt.model,
          promptCacheScope: attempt.promptCacheScope ?? input.promptCacheScope,
          onTextSnapshot: input.onTextSnapshot
            ? (text) => {
              partialEmitted = true;
              input.onTextSnapshot?.(text);
            }
            : undefined,
        });
        markVoiceInputProviderSuccess('refiner', attempt.profileId);
        if (index > 0) {
          log.info('refine fallback succeeded', {
            profileId: attempt.profileId,
            model: attempt.model,
            attempt: index + 1,
            skipped: ordered.slice(0, index).map((skipped) => skipped.profileId),
          });
        }
        return result;
      } catch (error) {
        lastError = error;
        // Include the cause chain: undici collapses every network-level
        // failure into a bare `fetch failed` whose actionable detail
        // (ETIMEDOUT / ECONNREFUSED / TLS alert) only lives in error.cause.
        const message = describeErrorWithCause(error);
        // Transport failures (network / idle timeout / HTTP / auth) mean the
        // channel is unhealthy → sticky cooldown. Model-output failures
        // (malformed JSON, empty content — see refinerErrorKind.ts) are a
        // one-off bad generation: still try the next model to rescue this
        // refinement, but do not penalize a healthy provider with cooldown.
        const modelOutputError = isRefinerModelOutputError(error);
        if (!modelOutputError) {
          markVoiceInputProviderFailure('refiner', attempt.profileId, message);
        }
        if (partialEmitted) {
          // Partial refinement text already reached the UI. Re-requesting on
          // another model would rewind visible text (jarring per design rule
          // "no visual jumps"), so give up and let the raw-ASR fallback stand.
          log.warn('refine failed after partial output, not falling back', {
            profileId: attempt.profileId,
            model: attempt.model,
            errorKind: modelOutputError ? 'model-output' : 'transport',
            error: message,
          });
          throw error;
        }
        log.warn('refine attempt failed, trying next model', {
          profileId: attempt.profileId,
          model: attempt.model,
          attempt: index + 1,
          totalAttempts: ordered.length,
          errorKind: modelOutputError ? 'model-output' : 'transport',
          error: message,
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('All voice input refiner providers failed.');
  }
}
