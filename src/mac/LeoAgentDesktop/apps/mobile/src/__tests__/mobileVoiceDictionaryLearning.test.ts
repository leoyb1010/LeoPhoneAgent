import { describe, expect, it, vi } from 'vitest';
import {
  createMobileVoiceDictionaryLearningTracker,
} from '@/session/mobileVoiceDictionaryLearning';

describe('mobileVoiceDictionaryLearning', () => {
  it('submits edited refined voice text after the desktop-style quiet window', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'prefix XDMaker suffix',
      rawTranscriptText: 'xd maker',
      refinedText: 'XDMaker',
      start: 7,
      end: 14,
      uiLanguage: 'zh-CN',
      sourceLanguage: 'zh-CN',
    });
    tracker.inspectDraft('prefix XDMaker App suffix');

    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(submit).toHaveBeenCalledWith({
      source: 'mobile',
      rawTranscriptText: 'xd maker',
      beforeText: 'XDMaker',
      afterText: 'XDMaker App',
      context: {
        uiLanguage: 'zh-CN',
        sourceLanguage: 'zh-CN',
        selectionBefore: 'prefix',
        selectionAfter: 'suffix',
      },
    });
    vi.useRealTimers();
  });

  it('flushes pending evidence immediately when the user sends before the quiet window', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'Open claw',
      rawTranscriptText: 'open claw',
      refinedText: 'Open claw',
      start: 0,
      end: 9,
    });
    tracker.inspectDraft('OpenClaw');
    tracker.flush();
    vi.advanceTimersByTime(1000);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: 'Open claw',
      afterText: 'OpenClaw',
    }));
    vi.useRealTimers();
  });

  it('drops the watch when surrounding draft text changes because mobile lacks editor transaction mapping', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'before XDMaker after',
      rawTranscriptText: 'xd maker',
      refinedText: 'XDMaker',
      start: 7,
      end: 14,
    });
    tracker.inspectDraft('changed before XDMaker after');
    vi.advanceTimersByTime(1000);

    expect(submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
