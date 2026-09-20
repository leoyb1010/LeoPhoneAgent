export const SEARCH_QUERY_MIN = 2;

export type SessionSearchHit = { file: string; line: number; text: string };

export function canSearchSession(machine?: string | null): boolean {
  return machine === 'local';
}

export function searchQueryReady(query: string): boolean {
  return query.trim().length >= SEARCH_QUERY_MIN;
}

export function clipSearchLine(text: string, limit = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= limit) return one;
  return `${one.slice(0, limit)}…`;
}

export function searchSessionToast(count: number, truncated: boolean): string {
  if (count <= 0) return '这个目录里没有这句话';
  return truncated ? `先看到 ${count} 处，还有` : `找到 ${count} 处`;
}
