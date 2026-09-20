/** 输入栏 `/命令` 走 prompt，跑着也能马上执行，不排到下一句。 */

export function parseComposerSlash(draft?: string | null): string | null {
  const text = String(draft ?? '').replace(/^\s+/, '').replace(/\s+$/, '');
  if (!/^\/[A-Za-z][\w:-]*(?:\s[\s\S]*)?$/.test(text)) return null;
  return text;
}

export function canRunSessionSlash(input: {
  machine?: string | null;
  status?: string | null;
  command?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!String(input.command ?? '').trim()) return false;
  const status = String(input.status ?? '');
  return status === 'running' || status === 'starting';
}
