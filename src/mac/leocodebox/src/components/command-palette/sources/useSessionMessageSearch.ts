import { useEffect, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { LLMProvider } from '../../../types/app';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function useSessionMessageSearch(
  projectId: string | undefined,
  query: string,
  enabled: boolean,
) {
  const [items, setItems] = useState<SessionMessageMatch[]>([]);
  const [coveredProviders, setCoveredProviders] = useState<string[]>([]);
  const seqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !projectId || trimmed.length < MIN_QUERY) {
      setItems([]);
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      return;
    }

    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    seqRef.current++;

    const handle = setTimeout(() => {
      const seq = ++seqRef.current;
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const accumulated: SessionMessageMatch[] = [];

      void apiClient.streamConversationSearch(trimmed, {
        result: (eventData: string) => {
          if (seq !== seqRef.current) { controller.abort(); return; }
          try {
            const data = JSON.parse(eventData) as { projectResult: ProjectResult };
            const pr = data.projectResult;
            if (pr.projectId !== projectId) return;
            for (const session of pr.sessions) {
              accumulated.push({
                sessionId: session.sessionId,
                label: session.sessionSummary || session.sessionId,
                snippet: session.matches[0]?.snippet ?? '',
                provider: session.provider,
              });
            }
            setItems([...accumulated]);
          } catch {
            // Ignore malformed SSE data.
          }
        },
        done: (eventData: string) => {
          try {
            const data = JSON.parse(eventData) as { coveredProviders?: string[] };
            if (Array.isArray(data.coveredProviders)) setCoveredProviders(data.coveredProviders);
          } catch {
            // Older servers send an empty done payload.
          }
          controller.abort();
        },
      }, 50, controller.signal).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('Conversation search failed:', error);
        }
      }).finally(() => {
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [projectId, query, enabled]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, []);

  return { items, coveredProviders };
}
