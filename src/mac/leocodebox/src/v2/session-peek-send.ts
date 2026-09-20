function peekSendPath(file?: string | null, cwd?: string | null): string {
  const raw = String(file ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const root = String(cwd ?? '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
  if (root && (raw === root || raw.startsWith(`${root}/`))) {
    return raw.slice(root.length).replace(/^[\\/]+/, '');
  }
  return raw.replace(/^\.\//, '');
}

export function promptHasPeekPath(prompt: string, file: string): boolean {
  const mention = file.trim();
  if (!mention) return false;
  if (prompt.includes(mention)) return true;
  const base = mention.split('/').pop() || '';
  return Boolean(base) && prompt.includes(base);
}

export function canMentionPeekOnSend(input: {
  machine?: string | null;
  drawer?: string | null;
  file?: string | null;
  cwd?: string | null;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.drawer !== 'files' && input.drawer !== 'diff') return false;
  const mention = peekSendPath(input.file, input.cwd);
  const prompt = String(input.prompt ?? '').trim();
  if (!mention || !prompt) return false;
  return !promptHasPeekPath(prompt, mention);
}

export function mentionPeekOnSend(input: {
  machine?: string | null;
  drawer?: string | null;
  file?: string | null;
  cwd?: string | null;
  prompt?: string | null;
}): string {
  const prompt = String(input.prompt ?? '').trim();
  if (!canMentionPeekOnSend(input)) return prompt;
  return `${prompt}\n${peekSendPath(input.file, input.cwd)}`;
}
