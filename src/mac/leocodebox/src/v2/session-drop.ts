export const DROP_MAX_BYTES = 12 * 1024 * 1024;

export function canAcceptSessionDrop(input: { machine?: string | null; cwd?: string | null }): boolean {
  return input.machine === 'local' && Boolean(input.cwd?.trim());
}

export function sanitizeDropName(raw: string, fallback = 'dropped.bin'): string {
  const base = raw.replace(/^.*[/\\]/, '').replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '').slice(0, 80);
  return base || fallback;
}

export function pasteImageName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `leo-paste-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

export function mentionDroppedFile(draft: string, filePath: string): string {
  const mention = filePath.trim();
  if (!mention) return draft;
  const text = draft.replace(/\s+$/, '');
  if (!text) return mention;
  if (text.includes(mention)) return text;
  return `${text}\n${mention}`;
}

export function droppedNativePath(file: { path?: string }): string | null {
  const next = file.path?.trim();
  return next || null;
}
