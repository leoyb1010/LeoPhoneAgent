import type { FlowRow } from './model';
import { canExportSession } from './session-export';

export const PRINT_TEXT_MAX = 200_000;

export function canPrintTalk(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return canExportSession(machine, rows);
}

export function clipPrintText(raw?: string | null, limit = PRINT_TEXT_MAX): string {
  const text = String(raw ?? '').split('\0').join('').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…(后面还有 ${text.length - limit} 字)\n`;
}

export function printTalkToast(): string {
  return '已打开打印';
}

export function printTalkUnavailableToast(): string {
  return '这台电脑现在打不了';
}
