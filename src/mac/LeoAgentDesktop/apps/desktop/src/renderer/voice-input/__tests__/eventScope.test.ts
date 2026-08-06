import { describe, expect, it } from 'vitest';

import { isVoiceInputEventScopeActive, shouldHandleVoiceInputEvent } from '../eventScope';

describe('voice input renderer event scope', () => {
  it('ignores events before the renderer owns a run', () => {
    expect(shouldHandleVoiceInputEvent(null, 'run-a')).toBe(false);
  });

  it('can accept pre-start-return events while the renderer is already starting', () => {
    expect(shouldHandleVoiceInputEvent(null, 'run-a', true)).toBe(true);
  });

  it('only treats active recording states as the pre-run grace period', () => {
    expect(isVoiceInputEventScopeActive('idle')).toBe(false);
    expect(isVoiceInputEventScopeActive('done')).toBe(false);
    expect(isVoiceInputEventScopeActive('error')).toBe(false);
    expect(isVoiceInputEventScopeActive('listening')).toBe(true);
    expect(isVoiceInputEventScopeActive('submitting')).toBe(true);
    expect(isVoiceInputEventScopeActive('refining')).toBe(true);
  });

  it('only accepts events for the owned run', () => {
    expect(shouldHandleVoiceInputEvent('run-a', 'run-a')).toBe(true);
    expect(shouldHandleVoiceInputEvent('run-a', 'run-b', true)).toBe(false);
  });

  it('keeps accepting terminal error details for the owned run after state becomes error', () => {
    expect(isVoiceInputEventScopeActive('error')).toBe(false);
    expect(shouldHandleVoiceInputEvent('run-a', 'run-a', isVoiceInputEventScopeActive('error'))).toBe(true);
    expect(shouldHandleVoiceInputEvent(null, 'run-a', isVoiceInputEventScopeActive('error'))).toBe(false);
  });
});
