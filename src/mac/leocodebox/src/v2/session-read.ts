import type { FlowRow } from './model';

const READ_TOOLS = new Set(['read', 'read_file', 'readfile']);

export function isReadTool(tool?: string | null): boolean {
  return READ_TOOLS.has((tool ?? '').trim().toLowerCase());
}

export function clipReadPath(preview?: string | null): string {
  const line = (preview ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? '';
  if (!line || line.length > 400) return '';
  const stripped = line.replace(/^(path|file|读取?)\s*[:：]\s*/i, '').trim();
  if (!stripped || stripped.startsWith('-')) return '';
  if (!/[\\/]/.test(stripped) && !/\.[A-Za-z0-9]{1,12}$/.test(stripped)) return '';
  return stripped;
}

export function readFileFromRow(row?: Pick<FlowRow, 'k'> & { tool?: string; preview?: string; running?: boolean } | null): string {
  if (!row || row.k !== 'tool' || row.running || !isReadTool(row.tool)) return '';
  return clipReadPath(row.preview);
}

export function lastReadFile(rows?: readonly FlowRow[] | null): string {
  if (!rows?.length) return '';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const file = readFileFromRow(rows[i]);
    if (file) return file;
  }
  return '';
}

export function canOpenLastRead(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(lastReadFile(rows));
}

export function openLastReadToast(file: string): string {
  const name = file.trim().replace(/\\/g, '/').split('/').pop() || file.trim();
  return name ? `已打开 ${name}` : '已打开刚读的文件';
}
