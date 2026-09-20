import type { FlowRow } from './model';

export const LAST_PROMPT_MAX = 8_000;

export function clipLastPrompt(text: string, limit = LAST_PROMPT_MAX): string {
  const clean = text.replace(/\u0000/g, '').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…(后面还有 ${clean.length - limit} 字)`;
}

export function lastUserPrompt(rows: readonly FlowRow[] | null | undefined): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'user' || !row.text.trim()) continue;
    if ((row.mode ?? 'prompt') !== 'prompt') continue;
    return clipLastPrompt(row.text);
  }
  return '';
}

export function canRetryLastUser(input: { canDrive?: boolean; running?: boolean; rows?: readonly FlowRow[] | null }): boolean {
  if (!input.canDrive || input.running) return false;
  return Boolean(lastUserPrompt(input.rows));
}

export function retryLastUserToast(): string {
  return '已再发上一句';
}
