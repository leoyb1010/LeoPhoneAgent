import { IS_PLATFORM } from '../constants/config';

export class ApiError extends Error {
  status: number;
  payload: any;

  constructor(message: string, { status = 0, payload = null }: { status?: number; payload?: any } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

// Only accept a refreshed token that has this app's issued JWT shape (three
// base64url segments). An attacker-injected/malformed header value must never
// overwrite the stored auth token. (Absorbed from upstream claudecodeui #971.)
export function isValidRefreshedToken(token: unknown): token is string {
  return typeof token === 'string'
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

// Retrying a 401 re-sends the request, so only do it where that is provably
// safe: an idempotent method, or a 401 the auth gate itself emitted before any
// handler ran (X-Auth-Required). A ReadableStream body is consumed by the first
// fetch and would throw on the second.
function canRetryUnauthorized(response: Response, options: RequestInit): boolean {
  if (typeof ReadableStream !== 'undefined' && options.body instanceof ReadableStream) return false;
  return IDEMPOTENT_METHODS.has((options.method || 'GET').toUpperCase())
    || response.headers.get('X-Auth-Required') === '1';
}

/**
 * Re-installs the desktop bridge's local auth token after a bundled-server
 * restart rotated it. Returns false everywhere else (browser, platform mode).
 */
export function refreshLocalAuthToken(): boolean {
  const localBridge = typeof window === 'undefined' ? undefined : window.leocodeboxLocal;
  return Boolean(localBridge?.enabled && localBridge.refreshAuthToken?.());
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const localBridge = typeof window === 'undefined' ? undefined : window.leocodeboxLocal;
  const send = () => {
    const token = localStorage.getItem('auth-token');
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (!IS_PLATFORM && token && (localBridge?.enabled || !headers.has('Authorization'))) {
      // The desktop bridge is the authority for loopback auth. Never let a
      // stale caller-provided header override the token it just installed.
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(url, { ...options, headers });
  };

  let response = await send();
  if (response.status === 401 && canRetryUnauthorized(response, options) && refreshLocalAuthToken()) {
    // A bundled server restart rotates the in-memory local token while the SPA
    // can remain alive. Refresh and retry once.
    response = await send();
  }
  const refreshedToken = response.headers.get('X-Refreshed-Token');
  if (isValidRefreshedToken(refreshedToken)) localStorage.setItem('auth-token', refreshedToken);
  return response;
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json')
    ? response.json().catch(() => ({}))
    : response.text().catch(() => '');
}

function resolveServerMessage(payload: unknown): unknown {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const error = record?.error;
  if (error && typeof error === 'object') return (error as Record<string, unknown>).message;
  return error || record?.message || record?.details || payload;
}

export async function apiRequest(url: string, options: RequestInit = {}): Promise<any> {
  const response = await authenticatedFetch(url, options);
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    const serverMessage = resolveServerMessage(payload);
    throw new ApiError(typeof serverMessage === 'string' && serverMessage
      ? serverMessage
      : `Request failed (${response.status}).`, { status: response.status, payload });
  }
  return payload;
}

type QueryValue = string | number | boolean | null | undefined;

function withQuery(path: string, query?: Record<string, QueryValue>) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await authenticatedFetch(path, options);
  if (response.ok) return response;
  const payload = await parseResponsePayload(response);
  const serverMessage = resolveServerMessage(payload);
  throw new ApiError(typeof serverMessage === 'string' && serverMessage
    ? serverMessage
    : `Request failed (${response.status}).`, { status: response.status, payload });
}

async function streamConversationSearch(
  query: string,
  handlers: Record<string, ((data: string) => void) | undefined> = {},
  limit = 50,
  signal?: AbortSignal,
): Promise<void> {
  const response = await rawRequest(withQuery('/api/providers/search/sessions', { q: query, limit }), {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.body) throw new Error('Conversation search stream is unavailable.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      handlers[event]?.(data.join('\n'));
    }
    if (done) break;
  }
}

export const apiClient = {
  streamConversationSearch,
  raw(path: string, options?: RequestInit): Promise<Response> {
    return rawRequest(path, options);
  },
  get<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    return apiRequest(withQuery(path, query), { method: 'GET', signal }) as Promise<T>;
  },
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  patch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  delete<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  deleteQuery<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    return apiRequest(withQuery(path, query), { method: 'DELETE', signal }) as Promise<T>;
  },
};
