import { mentionWindowRead, type FlowRow } from './model';

export const LAST_REPLY_MAX = 8_000;

export function clipLastReply(text: string, limit = LAST_REPLY_MAX): string {
  const clean = text.replace(/\u0000/g, '').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…(后面还有 ${clean.length - limit} 字)`;
}

export function lastAiReply(rows: readonly FlowRow[] | null | undefined): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k === 'ai' && !row.streaming && row.text.trim()) return clipLastReply(row.text);
  }
  return '';
}

export function canMentionLastReply(rows?: readonly FlowRow[] | null): boolean {
  return Boolean(lastAiReply(rows));
}

export function mentionLastReply(draft: string, reply: string): string {
  return mentionWindowRead(draft, clipLastReply(reply));
}

export function mentionLastReplyToast(): string {
  return '已带上模型上一句';
}
