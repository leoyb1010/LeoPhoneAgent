import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// apiClient reads the auth token from localStorage; node has no window.
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

const { useSessionStore } = await import('./useSessionStore');

type Store = ReturnType<typeof useSessionStore>;

function mountStore(): Store {
  let captured!: Store;
  function Probe() {
    captured = useSessionStore();
    return null;
  }
  act(() => { TestRenderer.create(<Probe />); });
  return captured;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('refreshFromServer re-reads a bounded tail page instead of the whole transcript', async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return jsonResponse({ success: true, data: { messages: [], total: 0, hasMore: false } });
  }) as typeof fetch;

  try {
    const store = mountStore();
    await act(async () => { await store.refreshFromServer('s1'); });
    // Nothing loaded yet → smallest page. An unbounded refresh used to pull
    // tens of MB of inline base64 screenshots on every `complete`.
    assert.match(requested[0], /\/api\/providers\/sessions\/s1\/messages\?limit=20&offset=0$/);

    // Once the pane shows more, the refresh keeps that many rows.
    const slot = store.getSlot('s1');
    slot.serverMessages = Array.from({ length: 57 }, (_, index) => ({
      id: `m${index}`, kind: 'text', role: 'user', content: String(index), timestamp: '', provider: 'claude', sessionId: 's1',
    })) as typeof slot.serverMessages;
    await act(async () => { await store.refreshFromServer('s1'); });
    assert.match(requested[1], /limit=57&offset=0$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a pruned transcript and a failed fetch are distinct slot states', async () => {
  const originalFetch = globalThis.fetch;
  let mode: 'missing' | 'boom' = 'missing';
  globalThis.fetch = (async () => {
    if (mode === 'boom') throw new TypeError('network down');
    return jsonResponse({ success: true, data: { messages: [], total: 0, hasMore: false, transcriptMissing: true } });
  }) as typeof fetch;

  try {
    const store = mountStore();
    let slot = store.getSlot('s2');
    await act(async () => { slot = await store.fetchFromServer('s2', { limit: 20, offset: 0 }); });
    assert.equal(slot.transcriptMissing, true);
    assert.equal(slot.status, 'idle');

    mode = 'boom';
    await act(async () => { slot = await store.fetchFromServer('s2', { limit: 20, offset: 0 }); });
    assert.equal(slot.status, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
