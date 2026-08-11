export function compareSemver(a: unknown, b: unknown): number {
  const parse = (value: unknown) => {
    const match = String(value || '').trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    return { core: [Number(match?.[1] || 0), Number(match?.[2] || 0), Number(match?.[3] || 0)], pre: match?.[4]?.split('.') || [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff !== 0) return diff;
  }
  if (!left.pre.length && right.pre.length) return 1;
  if (left.pre.length && !right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const lnum = /^\d+$/.test(left.pre[index]) ? Number(left.pre[index]) : null;
    const rnum = /^\d+$/.test(right.pre[index]) ? Number(right.pre[index]) : null;
    if (lnum !== null && rnum !== null && lnum !== rnum) return lnum - rnum;
    if (lnum !== null && rnum === null) return -1;
    if (lnum === null && rnum !== null) return 1;
    const compared = left.pre[index].localeCompare(right.pre[index]);
    if (compared) return compared;
  }
  return 0;
}

export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const proxyConfigured = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
    || process.env.https_proxy || process.env.http_proxy || process.env.all_proxy);
  if (proxyConfigured && !proxyAgent) proxyAgent = new EnvHttpProxyAgent();
  const response = await undiciFetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'leocodebox-local-update-check',
    },
    signal: AbortSignal.timeout(12_000),
    dispatcher: proxyConfigured ? proxyAgent : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

let proxyAgent: EnvHttpProxyAgent | undefined;
