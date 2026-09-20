/** message_end 才是成文；没流过字的时候要把正文补上，不能只剩用量。 */

export function sessionAssistantBlocks(message?: unknown): { text: string; thinking: string } {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { text: '', thinking: '' };
  const row = message as Record<string, unknown>;
  const texts: string[] = [];
  const thinks: string[] = [];
  if (typeof row.content === 'string' && row.content) texts.push(row.content);
  const blocks = Array.isArray(row.content) ? row.content : [];
  for (const raw of blocks) {
    const block = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const kind = String(block.type ?? '');
    if (kind === 'text' && typeof block.text === 'string' && block.text) texts.push(block.text);
    if (kind === 'thinking' && typeof block.thinking === 'string' && block.thinking) thinks.push(block.thinking);
  }
  return { text: texts.join(''), thinking: thinks.join('') };
}

export function sessionAssistantNeedsText(input: {
  streamed?: unknown;
  role?: string | null;
  text?: string | null;
} = {}): boolean {
  if (input.streamed) return false;
  if (String(input.role ?? 'assistant') !== 'assistant') return false;
  return Boolean(input.text);
}
