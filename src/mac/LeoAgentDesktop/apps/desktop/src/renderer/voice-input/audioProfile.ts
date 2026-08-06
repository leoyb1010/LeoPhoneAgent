import type { AudioProcessingConfig, WebMicAudioEngineOptions } from './WebMicAudioEngine';

export const VOICE_INPUT_CAPTURE_CHUNK_MS = 40;
export const VOICE_INPUT_CAPTURE_LATENCY_MS = 10;

// Keep capture responsive without making the mic permanently active: disable
// echo cancellation and AGC to avoid extra processing delay/level pumping,
// but keep noise suppression because it generally helps speech recognition in
// normal rooms.
export const VOICE_INPUT_CAPTURE_PROCESSING: AudioProcessingConfig = {
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: false,
};

// This profile is deliberately shared by normal and fast-activation recording:
// both paths benefit from smaller chunks and a lower capture latency hint. The
// keepAlive flag only controls whether the MediaStream stays warm after use.
// If field ASR quality regresses in echo-heavy environments, tune processing
// here explicitly instead of silently restoring WebMicAudioEngine defaults.
export function createVoiceInputAudioProfile(
  fastActivationEnabled: boolean,
): Pick<WebMicAudioEngineOptions, 'chunkMs' | 'audioProcessing' | 'latencyMs' | 'keepAlive'> {
  return {
    chunkMs: VOICE_INPUT_CAPTURE_CHUNK_MS,
    audioProcessing: VOICE_INPUT_CAPTURE_PROCESSING,
    latencyMs: VOICE_INPUT_CAPTURE_LATENCY_MS,
    keepAlive: fastActivationEnabled,
  };
}
