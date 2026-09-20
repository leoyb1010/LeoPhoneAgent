import { mentionWindowRead, type FlowRow } from './model';
import { clipLastReply } from './session-reply';

export function lastToolOutput(rows?: readonly FlowRow[] | null): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if ((row.k !== 'tool' && row.k !== 'edit') || row.running) continue;
    const head = (row.k === 'tool' ? (row.preview || row.tool) : (row.file || row.tool)).trim();
    const out = row.output.replace(/\u0000/g, '').replace(/\s+$/, '');
    if (!out) continue;
    return clipLastReply(head ? `$ ${head}\n${out}` : out);
  }
  return '';
}

export function canMentionLastTool(rows?: readonly FlowRow[] | null): boolean {
  return Boolean(lastToolOutput(rows));
}

export function mentionLastTool(draft: string, output: string): string {
  return mentionWindowRead(draft, clipLastReply(output));
}

export function mentionLastToolToast(): string {
  return '已带上刚打出来的';
}
