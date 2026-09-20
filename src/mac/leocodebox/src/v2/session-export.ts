import { userTurnLabel, type FlowRow } from './model';

export const EXPORT_MARKDOWN_MAX = 800_000;

export function canExportSession(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(rows?.some((row) => row.k === 'user' || row.k === 'ai'));
}

export function exportFileName(title: string): string {
  const safe = title.trim().replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '').replace(/-+$/g, '').slice(0, 40);
  return safe ? `leo-对话-${safe}.md` : 'leo-对话.md';
}

export function clipExportMarkdown(text: string, limit = EXPORT_MARKDOWN_MAX): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…(后面还有 ${text.length - limit} 字)\n`;
}

function rowMarkdown(row: FlowRow, model: string): string | null {
  if (row.k === 'user') return `## ${userTurnLabel(row.mode ?? 'prompt')}\n\n${row.text.trim()}`;
  if (row.k === 'ai' && row.text.trim()) return `## ${model || '模型'}\n\n${row.text.trim()}`;
  if (row.k === 'edit' && row.file.trim()) return `## ${row.tool === 'write' ? '写入' : '编辑'}\n\n\`${row.file.trim()}\``;
  if (row.k === 'tool' && (row.preview || row.tool).trim()) return `## $\n\n\`${(row.preview || row.tool).trim()}\``;
  return null;
}

export function flowRowsToMarkdown(input: {
  title?: string | null;
  cwd?: string | null;
  model?: string | null;
  rows: readonly FlowRow[];
}): string {
  const title = input.title?.trim() || '这次对话';
  const cwd = input.cwd?.trim();
  const model = input.model?.trim() || '';
  const body = input.rows
    .map((row) => rowMarkdown(row, model.split(/[\s/]/)[0] || '模型'))
    .filter((part): part is string => Boolean(part));
  if (!body.length) throw new Error('还没有可记下的对话');
  const head = [`# ${title}`, '', ...(cwd ? [`- 目录: ${cwd}`] : []), ...(model ? [`- 模型: ${model}`] : []), ''];
  return clipExportMarkdown(`${head.join('\n')}\n${body.join('\n\n')}\n`);
}

export function exportSessionToast(name: string): string {
  const short = name.trim();
  return short ? `已记下这次对话 · ${short}` : '已记下这次对话';
}
