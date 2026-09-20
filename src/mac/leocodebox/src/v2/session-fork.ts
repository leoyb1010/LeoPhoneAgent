import type { FlowRow } from './model';

export const FORK_SEED_MAX = 6000;

function clipLine(text: string, limit = 280): string {
  const next = text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (next.length <= limit) return next;
  return `${next.slice(0, limit)}…`;
}

export function forkTitle(title?: string | null): string {
  const suffix = '（分出来）';
  const base = (title ?? '').replace(/\s+/g, ' ').trim().replace(/（分出来）$/u, '') || '会话';
  return `${base.slice(0, Math.max(8, 80 - suffix.length))}${suffix}`;
}

export function canForkSession(machine?: string | null, cwd?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(cwd?.trim()) && Boolean(rows?.some((row) => row.k === 'user' || row.k === 'ai'));
}

export function forkSeedText(input: {
  title?: string | null;
  cwd?: string | null;
  model?: string | null;
  rows?: readonly FlowRow[] | null;
}): string {
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim() || '上一条会话';
  const cwd = (input.cwd ?? '').trim();
  const model = (input.model ?? '').trim();
  const turns: string[] = [];
  const files: string[] = [];
  for (const row of input.rows ?? []) {
    if (row.k === 'user' && (row.mode ?? 'prompt') === 'prompt' && row.text.trim()) {
      turns.push(`你: ${clipLine(row.text)}`);
    } else if (row.k === 'ai' && row.text.trim()) {
      turns.push(`模型: ${clipLine(row.text)}`);
    } else if (row.k === 'edit' && row.file.trim() && !files.includes(row.file.trim())) {
      files.push(row.file.trim());
    }
  }
  const kept = turns.slice(-10);
  const body = [
    `从「${title}」分出来。先接上上一条，等下一句再动手，不要改文件。`,
    cwd ? `目录: ${cwd}` : '',
    model ? `模型: ${model}` : '',
    kept.length ? kept.join('\n') : '',
    files.length ? `写过: ${files.slice(0, 12).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  if (body.length <= FORK_SEED_MAX) return body;
  return `${body.slice(0, FORK_SEED_MAX - 1)}…`;
}

export function forkSessionToast(title?: string | null): string {
  const name = (title ?? '').replace(/\s+/g, ' ').trim();
  return name ? `已分出「${name}」` : '已分出一条';
}
