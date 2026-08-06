import type { DictationRefinementContext } from '@cindy/voice-input-core';
import {
  MAX_REFINEMENT_HISTORY_ITEM_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES,
  VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
  VOICE_INPUT_HISTORY_HEADER,
} from '../../shared/voiceInputData';

export const MAX_REFINEMENT_SIDE_CONTEXT_CHARS = 1_200;
export const MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS = 500;
export const VOICE_INPUT_REFINEMENT_CACHE_SCOPE = 'voice-input-refinement';
export {
  VOICE_INPUT_HISTORY_COMPACT_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES,
  VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
};

export type VoiceInputChatMessage = {
  role: string;
  content: string;
  isStreaming?: boolean;
};

export function truncateContextText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim();
}

export function buildReplyToMessageFromChatMessages(messages: VoiceInputChatMessage[] | undefined): string | undefined {
  if (!messages?.length) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.isStreaming || message.role !== 'assistant') continue;
    return truncateContextText(message.content, MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS) || undefined;
  }
  return undefined;
}

/**
 * Build the only long-lived history block sent to refinement: prior voice
 * input text, oldest first. Normal chat history is deliberately excluded.
 *
 * The model only needs this as a terminology/style hint, so one bounded block
 * is simpler and less surprising than separate stable/recent fields.
 */
export function buildVoiceInputHistoryContext(
  newestFirst: ReadonlyArray<{ text: string }>,
): Pick<DictationRefinementContext, 'voiceInputHistory'> {
  const oldestFirst = normalizeVoiceInputHistoryEntries(newestFirst);
  if (oldestFirst.length === 0) return {};
  return {
    voiceInputHistory: [
      VOICE_INPUT_HISTORY_HEADER,
      ...oldestFirst.map((entry) => `- ${entry}`),
    ].join('\n'),
  };
}

export function estimateVoiceInputHistoryContextChars(newestFirst: ReadonlyArray<{ text: string }>): number {
  const oldestFirst = normalizeVoiceInputHistoryEntries(newestFirst);
  if (oldestFirst.length === 0) return 0;
  return oldestFirst.reduce(
    (total, entry) => total + 3 + entry.length,
    VOICE_INPUT_HISTORY_HEADER.length,
  );
}

function normalizeVoiceInputHistoryEntries(newestFirst: ReadonlyArray<{ text: string }>): string[] {
  return newestFirst
    .slice()
    .reverse()
    .map((entry) => truncateContextText(entry.text, MAX_REFINEMENT_HISTORY_ITEM_CHARS))
    .filter(Boolean);
}

export function takeContextHead(text: string, maxChars: number): string {
  return truncateContextText(text, maxChars);
}

export function takeContextTail(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars).trim();
}
