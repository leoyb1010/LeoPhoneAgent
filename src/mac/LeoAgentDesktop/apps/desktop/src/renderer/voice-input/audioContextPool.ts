/**
 * Shared AudioContext + AudioWorklet module pool for voice input.
 *
 * AudioContext creation and `audioWorklet.addModule` together cost 30-100ms
 * on cold start: the WebMicAudioEngine pays this on every `start()` because it
 * also closes the context on `stop()`. The user-perceived latency from
 * "shortcut pressed" to "mic recording" includes this cost.
 *
 * This module keeps a single suspended `AudioContext` alive across recording
 * sessions and pre-loads the PCM16k worklet module into it. The first
 * `start()` after `prewarmVoiceInputAudio()` only pays for `getUserMedia`
 * plus a few node `connect` calls.
 *
 * Lifecycle notes:
 * - The shared context is intentionally never `close()`-d. macOS privacy
 *   indicators and per-session MediaStream lifetimes are governed by
 *   `getUserMedia`/track.stop(), not by AudioContext lifetime.
 * - Engines that opt-in via `useShared: true` must NOT close the context on
 *   stop; they only disconnect their own nodes.
 * - If the shared context ever enters a non-running state (e.g. tab
 *   suspended), engines will resume() it inside `start()` like before.
 */

const PCM16K_WORKLET_NAME = 'pcm16k-worklet';

type SharedAudioState = {
  context: AudioContext;
  workletReady: Promise<void>;
  workletUrl: string;
};

let sharedState: SharedAudioState | null = null;

/**
 * Eagerly create the shared AudioContext (suspended) and load the worklet
 * module. Safe to call multiple times; subsequent calls return the same
 * promise. Returns the resolved state so callers can await readiness.
 */
export async function prewarmVoiceInputAudio(workletUrl: string): Promise<SharedAudioState> {
  if (sharedState && sharedState.workletUrl === workletUrl) {
    await sharedState.workletReady;
    return sharedState;
  }

  // If the workletUrl ever differs (dev HMR), drop the prior state. The old
  // context is left as-is; it will be GC'd once nothing references it.
  if (sharedState && sharedState.workletUrl !== workletUrl) {
    sharedState = null;
  }

  // Create a fresh context and let it stay 'running'. Empirically (see
  // logs around 01:32-01:38), explicitly suspending costs ~400ms on the
  // first session because resume() on macOS Core Audio is much slower than
  // a no-op state check. With no nodes connected to destination the audio
  // thread does no real work, so leaving the context running is free.
  const context = new AudioContext();

  const workletReady = context.audioWorklet
    .addModule(workletUrl)
    .catch((error) => {
      // Reset state so the next call retries cleanly. We surface the error to
      // the caller so it can fall back to per-instance setup.
      sharedState = null;
      throw error;
    });

  sharedState = { context, workletReady, workletUrl };
  await workletReady;
  return sharedState;
}

/**
 * Return the prewarmed shared state synchronously, or null if nothing has
 * been prewarmed yet (or a previous prewarm failed). Used by engines to
 * decide whether to take the fast path.
 */
export function getSharedVoiceInputAudio(): SharedAudioState | null {
  return sharedState;
}

export { PCM16K_WORKLET_NAME };
