import { useCallback, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { LLMProvider } from '../../../types/app';

export const HANDOFF_TARGET_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'grok'];

type HistoryMessage = {
  kind?: string;
  role?: 'user' | 'assistant';
  content?: string;
};

type HistoryResponse = {
  success?: boolean;
  data?: { messages?: HistoryMessage[] };
};

/**
 * Builds a compact, editable context summary for cross-provider continuation.
 * The summary is deterministic and local: it preserves decisions and recent
 * user/assistant outcomes without sending conversation history to a third API.
 */
export function buildHandoffText(sourceProvider: string, messages: HistoryMessage[]): string {
  const turns = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string' && message.content.trim())
    .slice(-12)
    .map((message) => {
      const text = message.content!.trim().replace(/\s+/g, ' ');
      const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      return `- ${message.role === 'user' ? 'Request' : 'Outcome'}: ${clipped}`;
    });

  return [
    `【Cross-provider handoff from ${sourceProvider}】`,
    '',
    'Context summary:',
    ...(turns.length ? turns : ['- No persisted text turns were available.']),
    '',
    'Continue from this state. First verify the current workspace rather than assuming the summary is authoritative.',
    '',
    'Next instruction:',
    '',
  ].join('\n');
}

export function useHandoffSource() {
  const [preparing, setPreparing] = useState(false);

  const prepare = useCallback(async (sessionId: string, sourceProvider: string): Promise<string> => {
    setPreparing(true);
    try {
      const response = await apiClient.get<HistoryResponse>(
        `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`,
        { limit: 40 },
      );
      const messages = response?.data?.messages ?? [];
      return buildHandoffText(sourceProvider, messages);
    } finally {
      setPreparing(false);
    }
  }, []);

  return { prepare, preparing };
}
