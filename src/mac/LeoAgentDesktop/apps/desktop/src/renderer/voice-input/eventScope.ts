import type { VoiceInputState } from '@cindy/voice-input-core';

export function isVoiceInputEventScopeActive(state: VoiceInputState): boolean {
  return state === 'listening' || state === 'submitting' || state === 'refining';
}

export function shouldHandleVoiceInputEvent(
  ownedRunId: string | null,
  eventRunId: string,
  acceptUnownedEvent = false,
): boolean {
  if (ownedRunId) return eventRunId === ownedRunId;
  return acceptUnownedEvent;
}
