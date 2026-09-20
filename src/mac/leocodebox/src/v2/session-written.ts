import type { FlowRow } from './model';

export function lastWrittenFile(rows?: readonly FlowRow[] | null): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k !== 'edit' || row.running) continue;
    const file = row.file.trim();
    if (file) return file;
  }
  return '';
}

export function canOpenLastWritten(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(lastWrittenFile(rows));
}

export function openLastWrittenToast(file: string): string {
  const name = file.trim().replace(/\\/g, '/').split('/').pop() || file.trim();
  return name ? `已打开 ${name}` : '已打开刚写的文件';
}
