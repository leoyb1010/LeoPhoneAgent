import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VOICE_INPUT_HISTORY_COMPACT_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES,
  VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
  buildVoiceInputHistoryContext,
  estimateVoiceInputHistoryContextChars,
} from '../refinementContext';
import {
  compactVoiceInputHistoryIfNeeded,
  createVoiceInputHistoryEntry,
  normalizeVoiceInputHistory,
  type VoiceInputHistoryEntry,
} from '../../../shared/voiceInputData';

let history: VoiceInputHistoryEntry[];
let now = 1_779_000_000_000;

beforeEach(() => {
  history = [];
  now = 1_779_000_000_000;
  vi.stubGlobal('window', {
    electronAPI: {
      voiceInput: {
        getHistory: vi.fn((limit?: number) => (
          typeof limit === 'number' ? history.slice(0, Math.max(0, limit)) : history
        )),
        getHistoryForRefinement: vi.fn(() => {
          history = compactVoiceInputHistoryIfNeeded(history);
          return history;
        }),
        recordHistory: vi.fn((text: string) => {
          const normalizedText = text.trim();
          const duplicate = history.find((entry) => entry.text === normalizedText);
          if (duplicate) return duplicate.id;
          const entry = createVoiceInputHistoryEntry(normalizedText);
          if (!entry) return null;
          history = compactVoiceInputHistoryIfNeeded(normalizeVoiceInputHistory([entry, ...history]));
          return entry.id;
        }),
        updateHistoryEntry: vi.fn(),
        deleteHistoryEntry: vi.fn(),
        onDataChanged: vi.fn(() => () => {}),
      },
    },
  });
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 1_000;
    return now;
  });
  vi.resetModules();
});

describe('voice input history retention', () => {
  it('keeps accumulating history below the context compaction threshold', async () => {
    const { getVoiceInputHistory, recordVoiceInputHistory } = await import('@/hooks/useVoiceInputHistory');

    for (let index = 0; index < 130; index += 1) {
      recordVoiceInputHistory(`stored dictation ${index + 1}`);
    }

    expect(getVoiceInputHistory()).toHaveLength(130);
    const context = buildVoiceInputHistoryContext(getVoiceInputHistory());
    expect(context.voiceInputHistory).toContain('语音输入历史');
    expect(context.voiceInputHistory).toContain('stored dictation 130');
    expect(context.voiceInputHistory).toContain('stored dictation 1');
  });

  it('rewrites history to a recent base with headroom once context exceeds the budget', async () => {
    const { getVoiceInputHistory, recordVoiceInputHistory } = await import('@/hooks/useVoiceInputHistory');
    const longText = '这是一段很长的语音输入历史'.repeat(80);

    for (let index = 0; index < 276; index += 1) {
      recordVoiceInputHistory(`stored dictation ${index + 1} ${longText}`);
    }

    const current = getVoiceInputHistory();
    expect(current.length).toBeGreaterThan(0);
    // Recording keeps appending after each compaction, so the steady state sits
    // between the compact target and the hard budget, never above the budget.
    expect(estimateVoiceInputHistoryContextChars(current)).toBeLessThanOrEqual(VOICE_INPUT_HISTORY_COMPACT_CHARS);
    expect(current[0]?.text).toContain('stored dictation 276');
    expect(current.at(-1)?.text).toContain(`stored dictation ${276 - current.length + 1} `);
    expect(current.some((entry) => entry.text.includes('stored dictation 1 '))).toBe(false);
  });

  it('compacts an over-budget history down to the target in one rewrite', () => {
    const longText = '这是一段很长的语音输入历史'.repeat(80);
    let entries: VoiceInputHistoryEntry[] = [];
    for (let index = 0; index < 276; index += 1) {
      const entry = createVoiceInputHistoryEntry(`stored dictation ${index + 1} ${longText}`);
      if (entry) entries = [entry, ...entries];
    }
    expect(estimateVoiceInputHistoryContextChars(entries)).toBeGreaterThan(VOICE_INPUT_HISTORY_COMPACT_CHARS);

    const compacted = compactVoiceInputHistoryIfNeeded(entries);
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted.length).toBeLessThanOrEqual(VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES);
    expect(estimateVoiceInputHistoryContextChars(compacted)).toBeLessThanOrEqual(
      VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
    );
    expect(compacted[0]?.text).toContain('stored dictation 276');
  });

  it('keeps the prompt prefix stable as history grows before and after compaction', async () => {
    const { getVoiceInputHistory, recordVoiceInputHistory } = await import('@/hooks/useVoiceInputHistory');
    const longText = '这是一段很长的语音输入历史'.repeat(80);

    for (let index = 0; index < 3; index += 1) {
      recordVoiceInputHistory(`cache warmup ${index + 1}`);
    }
    const beforeAppend = buildVoiceInputHistoryContext(getVoiceInputHistory()).voiceInputHistory ?? '';

    recordVoiceInputHistory('cache warmup 4');
    const afterAppend = buildVoiceInputHistoryContext(getVoiceInputHistory()).voiceInputHistory ?? '';
    expect(afterAppend.startsWith(`${beforeAppend}\n- cache warmup 4`)).toBe(true);

    for (let index = 0; index < 276; index += 1) {
      recordVoiceInputHistory(`stored dictation ${index + 1} ${longText}`);
    }
    const afterCompaction = buildVoiceInputHistoryContext(getVoiceInputHistory()).voiceInputHistory ?? '';
    expect(estimateVoiceInputHistoryContextChars(getVoiceInputHistory())).toBeLessThanOrEqual(
      VOICE_INPUT_HISTORY_COMPACT_CHARS,
    );

    recordVoiceInputHistory('post compact append');
    const afterPostCompactAppend = buildVoiceInputHistoryContext(getVoiceInputHistory()).voiceInputHistory ?? '';
    expect(afterPostCompactAppend.startsWith(`${afterCompaction}\n- post compact append`)).toBe(true);
  });
});
