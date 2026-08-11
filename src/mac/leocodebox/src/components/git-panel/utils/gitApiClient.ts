import { apiRequest } from '../../../utils/apiClient';

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function buildGitUrl(
  endpoint: string,
  query: Record<string, string | number | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return `/api/git/${endpoint}${queryString ? `?${queryString}` : ''}`;
}

export async function gitGet<T>(
  endpoint: string,
  query: Record<string, string | number | null | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest(buildGitUrl(endpoint, query), { signal }) as Promise<T>;
}

export async function gitPost<T>(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest(buildGitUrl(endpoint), {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  }) as Promise<T>;
}
