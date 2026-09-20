export function clipCommitMessage(raw: string, limit = 200): string {
  return raw.replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function defaultCommitMessage(title: string): string {
  return clipCommitMessage(title) || '记下这次改动';
}

export function canCommitSessionFiles(machine?: string | null, files?: readonly string[] | null): boolean {
  return machine === 'local' && Boolean(files?.some((file) => file.trim()));
}

export function commitSessionFilesToast(hash: string): string {
  const short = hash.trim();
  return short ? `已记下 ${short}` : '已记下这次改动';
}
