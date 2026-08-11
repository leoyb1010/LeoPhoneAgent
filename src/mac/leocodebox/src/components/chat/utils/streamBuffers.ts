import type { LLMProvider } from '../../../types/app';

export type StreamBufferEntry = {
  buffer: string;
  timer: number | null;
  provider: LLMProvider;
};

const PROVIDERS = new Set<LLMProvider>(['claude', 'cursor', 'codex', 'opencode']);

export function resolveStreamProvider(value: unknown, fallback: LLMProvider): LLMProvider {
  return typeof value === 'string' && PROVIDERS.has(value as LLMProvider)
    ? value as LLMProvider
    : fallback;
}

export function getOrCreateStreamBuffer(
  buffers: Map<string, StreamBufferEntry>,
  sessionId: string,
  provider: LLMProvider,
): StreamBufferEntry {
  const existing = buffers.get(sessionId);
  if (existing) {
    existing.provider = provider;
    return existing;
  }

  const entry: StreamBufferEntry = { buffer: '', timer: null, provider };
  buffers.set(sessionId, entry);
  return entry;
}

export function disposeStreamBuffers(buffers: Map<string, StreamBufferEntry>): void {
  for (const entry of buffers.values()) {
    if (entry.timer) window.clearTimeout(entry.timer);
  }
  buffers.clear();
}
