import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { SidebarSearchMode } from '../types/types';

type SnippetHighlight = {
  start: number;
  end: number;
};

type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

type ConversationProjectResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  totalMatches: number;
  query: string;
};

export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};


export type ConversationResultEvent = {
  projectResult: ConversationProjectResult;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

export type ConversationProgressEvent = {
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

export function parseConversationResultEvent(eventData: string): ConversationResultEvent | null {
  try {
    const parsed = JSON.parse(eventData) as Partial<ConversationResultEvent>;
    if (!parsed.projectResult || !Array.isArray(parsed.projectResult.sessions)) return null;
    if (![parsed.totalMatches, parsed.scannedProjects, parsed.totalProjects].every(Number.isFinite)) return null;
    return parsed as ConversationResultEvent;
  } catch {
    return null;
  }
}

export function parseConversationProgressEvent(eventData: string): ConversationProgressEvent | null {
  try {
    const parsed = JSON.parse(eventData) as Partial<ConversationProgressEvent>;
    if (![parsed.totalMatches, parsed.scannedProjects, parsed.totalProjects].every(Number.isFinite)) return null;
    return parsed as ConversationProgressEvent;
  } catch {
    return null;
  }
}

export function useConversationSearch(searchFilter: string, searchMode: SidebarSearchMode) {
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const searchSeqRef = useRef(0);
  const conversationSearchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearchQuery(searchFilter.trim()), 300);
    return () => clearTimeout(timeout);
  }, [searchFilter]);

  useEffect(() => {
    conversationSearchAbortRef.current?.abort();
    conversationSearchAbortRef.current = null;

    const query = debouncedSearchQuery;
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const seq = ++searchSeqRef.current;
    const controller = new AbortController();
    conversationSearchAbortRef.current = controller;

    const accumulated: ConversationProjectResult[] = [];
    let totalMatches = 0;
    const finish = () => {
      if (seq !== searchSeqRef.current) return;
      if (conversationSearchAbortRef.current === controller) conversationSearchAbortRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      if (accumulated.length === 0) {
        setConversationResults({ results: [], totalMatches: 0, query });
      }
    };

    void apiClient.streamConversationSearch(query, {
      result: (eventData: string) => {
        if (seq !== searchSeqRef.current) { controller.abort(); return; }
        const data = parseConversationResultEvent(eventData);
        if (!data) return;
        accumulated.push(data.projectResult);
        totalMatches = data.totalMatches;
        setConversationResults({ results: [...accumulated], totalMatches, query });
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      },
      progress: (eventData: string) => {
        if (seq !== searchSeqRef.current) { controller.abort(); return; }
        const data = parseConversationProgressEvent(eventData);
        if (!data) return;
        totalMatches = data.totalMatches;
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      },
      done: finish,
    }, 50, controller.signal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('Conversation search failed:', error);
      }
    }).finally(finish);

    return () => {
      controller.abort();
      if (conversationSearchAbortRef.current === controller) {
        conversationSearchAbortRef.current = null;
      }
    };
  }, [debouncedSearchQuery, searchMode]);

  const clearConversationResults = useCallback(() => {
    searchSeqRef.current += 1;
    conversationSearchAbortRef.current?.abort();
    conversationSearchAbortRef.current = null;
    setIsSearching(false);
    setSearchProgress(null);
    setConversationResults(null);
  }, []);

  return {
    conversationResults,
    isSearching,
    searchProgress,
    debouncedSearchQuery,
    clearConversationResults,
  };
}
