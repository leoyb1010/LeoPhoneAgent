import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, apiRequest } from './apiClient';

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
  return values;
}

test('apiRequest returns parsed JSON and persists refreshed authentication tokens', async () => {
  const values = installLocalStorage();
  const originalFetch = globalThis.fetch;
  // Only JWT-shaped tokens (three base64url segments) may be stored — an
  // injected/malformed header value must never overwrite the auth token.
  const jwtShaped = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.c2lnbmF0dXJl';
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-refreshed-token': jwtShaped,
    },
  });

  try {
    assert.deepEqual(await apiRequest('/api/test'), { success: true });
    assert.equal(values.get('auth-token'), jwtShaped);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiRequest rejects malformed refreshed tokens instead of storing them', async () => {
  const values = installLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-refreshed-token': 'not-a-jwt',
    },
  });

  try {
    assert.deepEqual(await apiRequest('/api/test'), { success: true });
    assert.equal(values.get('auth-token'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiRequest converts server error payloads into structured ApiError instances', async () => {
  installLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Repository not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

  try {
    await assert.rejects(
      () => apiRequest('/api/git/status'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, 'Repository not found');
        assert.equal(error.status, 404);
        assert.deepEqual(error.payload, { error: 'Repository not found' });
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiClient raw preserves successful binary responses and normalizes failures', async () => {
  const { apiClient } = await import('./apiClient');
  installLocalStorage();
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return new Response(JSON.stringify({ message: 'Binary asset missing' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await apiClient.raw('/api/assets/binary');
    assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3]);
    await assert.rejects(
      () => apiClient.raw('/api/assets/missing'),
      (error: unknown) => error instanceof ApiError
        && error.status === 404
        && error.message === 'Binary asset missing',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiClient deleteQuery preserves DELETE query semantics without a request body', async () => {
  const { apiClient } = await import('./apiClient');
  installLocalStorage();
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await apiClient.deleteQuery('/api/providers/sessions/test', { force: true });
    assert.equal(capturedUrl, '/api/providers/sessions/test?force=true');
    assert.equal(capturedInit?.method, 'DELETE');
    assert.equal(capturedInit?.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiClient streams named SSE events through the unified authenticated layer', async () => {
  const { apiClient } = await import('./apiClient');
  installLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'event: progress\ndata: {"totalMatches":1}\n\nevent: done\ndata: {}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const events: string[] = [];
  try {
    await apiClient.streamConversationSearch('hello', {
      progress: (data) => events.push(`progress:${data}`),
      done: (data) => events.push(`done:${data}`),
    });
    assert.deepEqual(events, ['progress:{"totalMatches":1}', 'done:{}']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
