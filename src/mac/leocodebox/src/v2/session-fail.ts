import type { FlowRow } from './model';

export function lastFailedRow(rows?: readonly FlowRow[] | null): FlowRow | null {
  if (!rows?.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.k === 'tool' || row.k === 'edit') {
      if (row.running) continue;
      if (row.error) return row;
      continue;
    }
    if (row.k === 'sys' && row.tone === 'error') return row;
  }
  return null;
}

export function lastFailedKey(rows?: readonly FlowRow[] | null): string {
  return lastFailedRow(rows)?.key ?? '';
}

export function canJumpLastFail(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(lastFailedKey(rows));
}

export function jumpLastFailToast(row?: FlowRow | null): string {
  if (!row) return '已跳到刚失败的';
  if (row.k === 'edit') {
    const name = row.file.trim().replace(/\\/g, '/').split('/').pop() || row.file.trim();
    return name ? `已跳到 ${name}` : '已跳到刚失败的';
  }
  if (row.k === 'tool') {
    const name = (row.preview || row.tool).trim().split('\n')[0]?.slice(0, 40);
    return name ? `已跳到 ${name}` : '已跳到刚失败的';
  }
  return '已跳到刚失败的';
}
