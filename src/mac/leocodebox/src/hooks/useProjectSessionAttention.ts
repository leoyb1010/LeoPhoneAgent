import { useCallback, useRef, useState } from 'react';

import type { ProjectSession } from '../types/app';

export function useProjectSessionAttention(selectedSession: ProjectSession | null, routeSessionId?: string) {
  const [attentionSessionIds, setAttentionSessionIds] = useState<Set<string>>(new Set());
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

  const markSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return;
    const viewedSessionId = selectedSessionRef.current?.id ?? routeSessionId ?? null;
    if (targetSessionId === viewedSessionId) return;
    setAttentionSessionIds((previous) => {
      if (previous.has(targetSessionId)) return previous;
      const next = new Set(previous);
      next.add(targetSessionId);
      return next;
    });
  }, [routeSessionId]);

  const clearSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return;
    setAttentionSessionIds((previous) => {
      if (!previous.has(targetSessionId)) return previous;
      const next = new Set(previous);
      next.delete(targetSessionId);
      return next;
    });
  }, []);

  return { attentionSessionIds, markSessionAttention, clearSessionAttention };
}
