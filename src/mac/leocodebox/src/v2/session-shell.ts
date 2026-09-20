/** 输入栏 `$ 命令` 在本机空闲会话里直接跑进上下文，不另开一轮。 */

export function parseComposerBash(draft?: string | null): string | null {
  const text = String(draft ?? '');
  if (!text.startsWith('$')) return null;
  const rest = text.slice(1);
  if (!/^[ \t\n]/.test(rest)) return null;
  const command = rest.replace(/^\s+/, '').replace(/\s+$/, '');
  return command || null;
}

export function canRunSessionBash(input: {
  machine?: string | null;
  status?: string | null;
  command?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!String(input.command ?? '').trim()) return false;
  const status = String(input.status ?? '');
  return status === 'idle' || status === 'failed';
}
