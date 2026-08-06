/**
 * helpThreadStore — single-thread state for the Help Assistant chat.
 *
 * One module-level thread (no "recent list"): the user either sees last time's
 * conversation or explicitly starts a new one. State is mirrored to localStorage
 * (renderer-only, no IPC, no main dependency) so the thread survives panel
 * close and app restart. Hydration runs on module load so the panel never
 * flashes empty-then-restore.
 */
import { useSyncExternalStore } from 'react';
import { createId } from '@paralleldrive/cuid2';

import { createLogger } from '@/lib/logger';
import {
  truncateHelpHistory,
  type HelpAnswerResult,
  type HelpLocale,
  type HelpMessage,
} from '@/../shared/helpTypes';

const log = createLogger('helpThreadStore');
const STORAGE_KEY = 'xdt-help-thread-v1';
const PERSIST_DEBOUNCE_MS = 150;

export interface HelpThreadState {
  messages: HelpMessage[];
  pending: boolean;
}

let state: HelpThreadState = { messages: [], pending: false };
const listeners = new Set<() => void>();

// Bumped on reset(); an in-flight ask() compares against it on resolve so a late
// answer from a discarded thread never repopulates a fresh one.
let askEpoch = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: HelpThreadState): void {
  state = next;
  emit();
}

// ---- persistence (renderer-only) ----

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistDebounced(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      // Only stable messages are persisted; pending is intentionally dropped so
      // a reopened panel never shows a half-finished spinner.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: state.messages }));
    } catch (err) {
      log.warn('persist failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, PERSIST_DEBOUNCE_MS);
}

function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    log.warn('clear persisted failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function isHelpMessage(value: unknown): value is HelpMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as HelpMessage;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
}

/**
 * Mark an assistant message (by its stable id) as "the user reported this
 * answer via the feedback flow". The draftId comes from main's
 * HELP_FEEDBACK_CREATE. The mark is persisted with the thread so the
 * "已记录反馈" indicator survives reopens / restarts. No-op if the id isn't
 * found or refers to a user row (defensive — UI should never call this on
 * a user row).
 *
 * Why by id, not by index: the array can shift between click and dispatch
 * (a queued user message lands, truncation kicks in, etc.). Index lookups
 * could then mark the WRONG message; id is stable.
 */
export function markMessageFeedbackSubmitted(messageId: string, draftId: string): void {
  const index = state.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return;
  const msg = state.messages[index];
  if (msg.role !== 'assistant') return;
  if (msg.feedbackDraftId === draftId) return;
  const next = state.messages.slice();
  next[index] = { ...msg, feedbackDraftId: draftId };
  setState({ ...state, messages: next });
  persistDebounced();
}

function hydrate(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { messages?: unknown };
    if (!parsed || !Array.isArray(parsed.messages)) return;
    // Backfill stable ids on any persisted message that pre-dates the id field.
    // Without this the renderer would fall back to array-index keys, which
    // breaks across truncation (feedback edit state could bleed to a different
    // message after the array shifts).
    const messages = parsed.messages
      .filter(isHelpMessage)
      .map((m) => (m.id ? m : { ...m, id: createId() }));
    if (messages.length === 0) return;
    state = { messages: truncateHelpHistory(messages), pending: false };
  } catch (err) {
    // Bad JSON / localStorage disabled → stay empty (silent degrade to memory).
    log.warn('hydrate failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

hydrate();

// ---- mutations ----

export function appendUserMessage(content: string): void {
  const message: HelpMessage = { id: createId(), role: 'user', content };
  setState({
    ...state,
    messages: truncateHelpHistory([...state.messages, message]),
  });
  persistDebounced();
}

/**
 * Append the assistant turn. `no-answer` is stored as an empty-content assistant
 * message; the UI renders the localized fallback for empty content. Dropped if
 * the thread was reset out from under an in-flight ask (length 0 guard).
 */
export function appendAssistantMessage(result: HelpAnswerResult): void {
  if (state.messages.length === 0) return;
  const id = createId();
  const message: HelpMessage =
    result.kind === 'ai' && result.action
      ? { id, role: 'assistant', content: result.answer, action: result.action }
      : { id, role: 'assistant', content: result.kind === 'ai' ? result.answer : '' };
  setState({
    ...state,
    messages: truncateHelpHistory([...state.messages, message]),
  });
  persistDebounced();
}

function setPending(pending: boolean): void {
  setState({ ...state, pending });
}

export function resetHelpThread(): void {
  askEpoch += 1;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  setState({ messages: [], pending: false });
  clearPersisted();
}

/**
 * Orchestrates one turn: append the user message, call main, append the answer.
 * Guards against double-send (pending) and against a late answer landing in a
 * thread that was reset/replaced while the IPC was in flight (epoch check).
 */
export async function askHelp(content: string, locale: HelpLocale): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed || state.pending) return;
  appendUserMessage(trimmed);
  setPending(true);
  const epoch = askEpoch;
  const messages = state.messages;
  let result: HelpAnswerResult;
  try {
    result = await window.electronAPI.maker.helpAsk({ messages, locale });
  } catch (err) {
    log.warn('helpAsk failed', { error: err instanceof Error ? err.message : String(err) });
    result = { kind: 'no-answer' };
  }
  if (epoch !== askEpoch) return; // thread was reset during flight — drop result
  appendAssistantMessage(result);
  setPending(false);
}

// ---- subscription ----

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getHelpThreadState(): HelpThreadState {
  return state;
}

export function useHelpThread(): HelpThreadState {
  return useSyncExternalStore(subscribe, getHelpThreadState, getHelpThreadState);
}

export function __resetHelpThreadStoreForTest(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  askEpoch = 0;
  state = { messages: [], pending: false };
}

export function __hydrateHelpThreadForTest(): void {
  hydrate();
}
