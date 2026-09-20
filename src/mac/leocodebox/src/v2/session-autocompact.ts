const OVERFLOW = /context (length|window)|too many tokens|maximum context|上下文太长/i;

export function looksLikeContextOverflow(text?: string | null): boolean {
  return OVERFLOW.test(String(text ?? ''));
}

export function shouldAutoCompact(input: {
  primed: boolean;
  machine?: string | null;
  prevStatus?: string | null;
  nextStatus?: string | null;
  errorText?: string | null;
}): boolean {
  if (!input.primed) return false;
  if ((input.machine ?? 'local') !== 'local') return false;
  if (input.nextStatus !== 'failed') return false;
  if (input.prevStatus === 'failed') return false;
  return looksLikeContextOverflow(input.errorText);
}

export function autoCompactToast(): string {
  return '上下文太长，已压缩';
}
