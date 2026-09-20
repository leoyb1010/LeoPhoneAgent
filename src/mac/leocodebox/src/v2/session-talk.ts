export const TALK_QUERY_MIN = 2;

export function canSearchSessionTalk(machine?: string | null): boolean {
  return machine === 'local';
}

export function talkQueryReady(query: string): boolean {
  return query.trim().length >= TALK_QUERY_MIN;
}

export function talkSearchToast(count: number): string {
  if (count <= 0) return '没有会话说过这句话';
  return count === 1 ? '找到 1 条说过这句话的会话' : `找到 ${count} 条说过这句话的会话`;
}
