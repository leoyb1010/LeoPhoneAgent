import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __hydrateHelpThreadForTest,
  __resetHelpThreadStoreForTest,
  appendAssistantMessage,
  appendUserMessage,
  askHelp,
  getHelpThreadState,
  markMessageFeedbackSubmitted,
  resetHelpThread,
} from '@/lib/helpThreadStore';
import type { HelpAnswerResult } from '@/../shared/helpTypes';

const KEY = 'xdt-help-thread-v1';

// The store only touches `localStorage` and `window.electronAPI` — stub those
// rather than pulling in jsdom for what is really a plain-state-machine test.
function createStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      store[k] = String(v);
    },
    removeItem: (k: string): void => {
      delete store[k];
    },
    clear: (): void => {
      store = {};
    },
  };
}

let storageMock: ReturnType<typeof createStorageMock>;

function setHelpAsk(impl: () => Promise<HelpAnswerResult>): void {
  (window as unknown as { electronAPI: { maker: { helpAsk: unknown } } }).electronAPI.maker.helpAsk = impl;
}

beforeEach(() => {
  storageMock = createStorageMock();
  vi.stubGlobal('localStorage', storageMock);
  vi.stubGlobal('window', {
    electronAPI: { maker: { helpAsk: async () => ({ kind: 'no-answer' }) as HelpAnswerResult } },
  });
  __resetHelpThreadStoreForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('hydrate', () => {
  it('loads valid persisted messages', () => {
    storageMock.setItem(
      KEY,
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] }),
    );
    __hydrateHelpThreadForTest();
    expect(getHelpThreadState().messages).toHaveLength(2);
  });

  it('stays empty on invalid JSON', () => {
    storageMock.setItem(KEY, '{not json');
    __hydrateHelpThreadForTest();
    expect(getHelpThreadState().messages).toHaveLength(0);
  });

  it('stays empty when nothing is persisted', () => {
    __hydrateHelpThreadForTest();
    expect(getHelpThreadState().messages).toHaveLength(0);
  });

  it('filters out malformed entries', () => {
    storageMock.setItem(
      KEY,
      JSON.stringify({ messages: [{ role: 'user', content: 'ok' }, { role: 'x' }, { foo: 1 }] }),
    );
    __hydrateHelpThreadForTest();
    expect(getHelpThreadState().messages).toEqual([
      { role: 'user', content: 'ok', id: expect.any(String) },
    ]);
  });

  it('backfills stable ids on messages that pre-date the id field', () => {
    storageMock.setItem(
      KEY,
      JSON.stringify({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }),
    );
    __hydrateHelpThreadForTest();
    const messages = getHelpThreadState().messages;
    expect(messages).toHaveLength(2);
    expect(typeof messages[0].id).toBe('string');
    expect(typeof messages[1].id).toBe('string');
    expect(messages[0].id).not.toBe(messages[1].id);
  });

  it('preserves the existing id on already-tagged messages', () => {
    storageMock.setItem(
      KEY,
      JSON.stringify({
        messages: [{ role: 'user', content: 'a', id: 'preserved-id' }],
      }),
    );
    __hydrateHelpThreadForTest();
    expect(getHelpThreadState().messages[0].id).toBe('preserved-id');
  });
});

describe('askHelp', () => {
  it('appends the user message then the assistant answer (with action)', async () => {
    setHelpAsk(async () => ({
      kind: 'ai',
      answer: 'Use Import.',
      action: { kind: 'settings-tab', tab: 'import' },
    }));
    await askHelp('how?', 'en');
    const { messages, pending } = getHelpThreadState();
    expect(pending).toBe(false);
    expect(messages).toEqual([
      { role: 'user', content: 'how?', id: expect.any(String) },
      {
        role: 'assistant',
        content: 'Use Import.',
        action: { kind: 'settings-tab', tab: 'import' },
        id: expect.any(String),
      },
    ]);
  });

  it('sets pending during flight and clears it after', async () => {
    let resolve!: (r: HelpAnswerResult) => void;
    setHelpAsk(() => new Promise<HelpAnswerResult>((r) => { resolve = r; }));
    const p = askHelp('q', 'en');
    expect(getHelpThreadState().pending).toBe(true);
    expect(getHelpThreadState().messages).toHaveLength(1);
    resolve({ kind: 'ai', answer: 'a' });
    await p;
    expect(getHelpThreadState().pending).toBe(false);
    expect(getHelpThreadState().messages).toHaveLength(2);
  });

  it('ignores a second send while one is pending', async () => {
    let resolve!: (r: HelpAnswerResult) => void;
    setHelpAsk(() => new Promise<HelpAnswerResult>((r) => { resolve = r; }));
    const p = askHelp('q1', 'en');
    await askHelp('q2', 'en');
    expect(getHelpThreadState().messages).toEqual([
      { role: 'user', content: 'q1', id: expect.any(String) },
    ]);
    resolve({ kind: 'ai', answer: 'a' });
    await p;
  });

  it('drops a late answer after the thread was reset (epoch guard)', async () => {
    let resolve!: (r: HelpAnswerResult) => void;
    setHelpAsk(() => new Promise<HelpAnswerResult>((r) => { resolve = r; }));
    const p = askHelp('q', 'en');
    resetHelpThread();
    resolve({ kind: 'ai', answer: 'late' });
    await p;
    expect(getHelpThreadState().messages).toHaveLength(0);
  });

  it('stores a no-answer result as an empty assistant turn', async () => {
    setHelpAsk(async () => ({ kind: 'no-answer' }));
    await askHelp('q', 'en');
    expect(getHelpThreadState().messages[1]).toEqual({
      role: 'assistant',
      content: '',
      id: expect.any(String),
    });
  });
});

describe('appendAssistantMessage', () => {
  it('is a no-op when the thread is empty (late append after reset)', () => {
    appendAssistantMessage({ kind: 'ai', answer: 'stray' });
    expect(getHelpThreadState().messages).toHaveLength(0);
  });
});

describe('markMessageFeedbackSubmitted', () => {
  it('tags the matching assistant message with the draft id', () => {
    appendUserMessage('q');
    appendAssistantMessage({ kind: 'ai', answer: 'a' });
    const assistantId = getHelpThreadState().messages[1].id;
    expect(assistantId).toBeTruthy();
    markMessageFeedbackSubmitted(assistantId!, 'draft-1');
    expect(getHelpThreadState().messages[1].feedbackDraftId).toBe('draft-1');
    // user row is untouched
    expect(getHelpThreadState().messages[0].feedbackDraftId).toBeUndefined();
  });

  it('is a no-op when the id is unknown (defensive against stale clicks)', () => {
    appendUserMessage('q');
    appendAssistantMessage({ kind: 'ai', answer: 'a' });
    markMessageFeedbackSubmitted('not-a-real-id', 'draft-x');
    expect(getHelpThreadState().messages[1].feedbackDraftId).toBeUndefined();
  });

  it('is a no-op when the target is a user row (defensive)', () => {
    appendUserMessage('q');
    const userId = getHelpThreadState().messages[0].id;
    markMessageFeedbackSubmitted(userId!, 'draft-x');
    expect(getHelpThreadState().messages[0].feedbackDraftId).toBeUndefined();
  });
});

describe('persistence', () => {
  it('coalesces writes within the debounce window', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(storageMock, 'setItem');
    appendUserMessage('a');
    appendUserMessage('b');
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(setItem).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(storageMock.getItem(KEY) ?? '{}') as { messages: { content: string }[] };
    expect(saved.messages.map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('reset clears both memory and persisted storage', () => {
    vi.useFakeTimers();
    appendUserMessage('a');
    vi.advanceTimersByTime(150);
    expect(storageMock.getItem(KEY)).toBeTruthy();
    resetHelpThread();
    expect(getHelpThreadState().messages).toHaveLength(0);
    expect(storageMock.getItem(KEY)).toBeNull();
  });
});
