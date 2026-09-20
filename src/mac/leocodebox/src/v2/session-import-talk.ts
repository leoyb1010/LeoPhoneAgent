export const IMPORT_SEED_MAX = 6000;

export function looksLikeTalkExport(name?: string | null): boolean {
  const base = (name ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return /^leo-对话.*\.md$/iu.test(base);
}

export function importTalkName(raw?: string | null): string {
  if (!looksLikeTalkExport(raw)) return '';
  return (raw ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}

export function canImportTalk(machine?: string | null, cwd?: string | null): boolean {
  return machine === 'local' && Boolean(cwd?.trim());
}

export function importTitle(name?: string | null): string {
  const suffix = '（接回来）';
  const base = (name ?? '')
    .replace(/^.*[/\\]/, '')
    .replace(/\.md$/i, '')
    .replace(/^leo-对话-?/u, '')
    .replace(/\s+/g, ' ')
    .trim() || '记下的对话';
  return `${base.slice(0, Math.max(8, 80 - suffix.length))}${suffix}`;
}

export function clipImportMarkdown(raw?: string | null, limit = IMPORT_SEED_MAX): string {
  const next = (raw ?? '').replace(/\u0000/g, '').trim();
  if (!next) return '';
  if (next.length <= limit) return next;
  return `${next.slice(0, limit)}…`;
}

export function importSeedText(input: { name?: string | null; markdown?: string | null }): string {
  const name = (input.name ?? '').replace(/^.*[/\\]/, '').trim() || 'leo-对话.md';
  const body = clipImportMarkdown(input.markdown);
  if (!body) throw new Error('这份记下的对话是空的');
  const lead = `接回记下的对话「${name}」。先确认已接上，等下一句再动手，不要改文件。`;
  const text = `${lead}\n\n${body}`;
  return text.length <= IMPORT_SEED_MAX + 80 ? text : `${text.slice(0, IMPORT_SEED_MAX + 79)}…`;
}

export function importTalkToast(name?: string | null): string {
  const title = importTitle(name);
  return `已接回「${title}」`;
}
