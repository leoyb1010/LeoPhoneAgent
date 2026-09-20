import type { FlowRow } from './model';
import { sessionIsBusyToHalt } from './session-halt';
import { lastUserPrompt } from './session-retry';

export function canRewindLastTurn(input: {
  machine?: string | null;
  status?: string | null;
  rows?: readonly FlowRow[] | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (sessionIsBusyToHalt(input.status)) return false;
  return Boolean(lastUserPrompt(input.rows));
}

export function dropLastPromptTurn(rows: readonly FlowRow[] | null | undefined, prompt?: string | null): FlowRow[] {
  if (!rows?.length) return [];
  const want = String(prompt ?? '').trim();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'user' || (row.mode ?? 'prompt') !== 'prompt') continue;
    if (want && row.text.trim() !== want) continue;
    return rows.slice(0, i);
  }
  return [...rows];
}

export function rewindLastTurnLabel(): string {
  return '这一轮不算';
}

export function rewindLastTurnToast(): string {
  return '上一轮已拿掉，上一句在输入栏';
}
