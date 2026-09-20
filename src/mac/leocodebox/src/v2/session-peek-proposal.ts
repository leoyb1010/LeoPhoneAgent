import type { FlowRow } from './model';
import { samePeekFile } from './session-peek-sync';

export const PROPOSAL_MAX = 200_000;

export function editProposalContent(args?: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const rec = args as Record<string, unknown>;
  for (const key of ['content', 'newText', 'new_text', 'new_string', 'text']) {
    const value = rec[key];
    if (typeof value !== 'string') continue;
    const text = value.replace(/\u0000/g, '');
    if (!text) continue;
    return text.length > PROPOSAL_MAX ? text.slice(0, PROPOSAL_MAX) : text;
  }
  return '';
}

export function pendingEditProposal(rows?: readonly FlowRow[] | null): { file: string; content: string } | null {
  if (!rows?.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'edit' || !row.running) continue;
    const file = row.file.trim();
    const content = String(row.proposed ?? '').trim() ? String(row.proposed) : '';
    if (file && content) return { file, content };
  }
  return null;
}

export function canShowPendingProposal(input: {
  machine?: string | null;
  status?: string | null;
  dirty?: boolean;
  focusFile?: string | null;
  pendingFile?: string | null;
  content?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  if (input.dirty) return false;
  if (!String(input.content ?? '')) return false;
  return samePeekFile(input.focusFile, input.pendingFile);
}
