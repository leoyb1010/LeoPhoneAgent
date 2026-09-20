import type { FlowRow } from './model';
import { samePeekFile } from './session-peek-sync';

export function pendingEditFile(rows?: readonly FlowRow[] | null): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'edit' || !row.running) continue;
    const file = row.file.trim();
    if (file) return file;
  }
  return '';
}

export function canPeekPendingEdit(input: {
  machine?: string | null;
  status?: string | null;
  dirty?: boolean;
  focusFile?: string | null;
  pendingFile?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  if (input.dirty) return false;
  const file = String(input.pendingFile ?? '').trim();
  if (!file) return false;
  return !samePeekFile(input.focusFile, file);
}
