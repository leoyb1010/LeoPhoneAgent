export function mentionableSessionFiles(files?: readonly (string | null | undefined)[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of files ?? []) {
    const file = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export function fileMentionToken(prompt?: string | null, cursor?: number | null): { start: number; query: string } | null {
  const text = String(prompt ?? '');
  const pos = cursor == null ? text.length : Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  if (/[\s\n]/.test(query)) return null;
  return { start: at, query };
}

export function matchMentionFiles(files: readonly string[], query: string): string[] {
  const list = mentionableSessionFiles(files);
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list
    .filter((file) => {
      const base = file.split('/').pop()?.toLowerCase() ?? '';
      return base.startsWith(q) || file.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const ab = a.split('/').pop()?.toLowerCase() ?? '';
      const bb = b.split('/').pop()?.toLowerCase() ?? '';
      return Number(bb.startsWith(q)) - Number(ab.startsWith(q));
    });
}

export function applyFileMention(prompt: string, token: { start: number }, file: string, cursor?: number | null): string {
  const mention = file.trim();
  if (!mention) return prompt;
  const end = cursor == null ? prompt.length : Math.max(token.start, Math.min(cursor, prompt.length));
  const after = prompt.slice(end);
  const gap = after && !/^\s/.test(after) ? ' ' : '';
  return `${prompt.slice(0, token.start)}${mention}${gap}${after}`;
}

export function canCompleteFileMention(input: {
  machine?: string | null;
  prompt?: string | null;
  cursor?: number | null;
  files?: readonly (string | null | undefined)[] | null;
}): boolean {
  if (input.machine !== 'local') return false;
  const token = fileMentionToken(input.prompt, input.cursor);
  if (!token) return false;
  return matchMentionFiles(mentionableSessionFiles(input.files), token.query).length > 0;
}
