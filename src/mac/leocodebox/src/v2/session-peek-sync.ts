import type { FlowRow } from './model';

function normPath(path?: string | null): string {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function samePeekFile(focus?: string | null, written?: string | null): boolean {
  const a = normPath(focus);
  const b = normPath(written);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function lastFinishedEdit(rows?: readonly FlowRow[] | null): { file: string; key: string } | null {
  if (!rows?.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'edit' || row.running || row.error) continue;
    const file = row.file.trim();
    if (file) return { file, key: row.key };
  }
  return null;
}

export function shouldReloadPeek(input: {
  machine?: string | null;
  focusFile?: string | null;
  dirty?: boolean;
  written?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.dirty) return false;
  return samePeekFile(input.focusFile, input.written);
}

export function peekReloadedToast(file?: string | null): string {
  const name = normPath(file).split('/').pop() || '';
  return name ? `预览已跟上 ${name}` : '预览已跟上刚写的';
}
