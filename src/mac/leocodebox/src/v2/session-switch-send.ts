export function canRetryAfterModelSwitch(input: {
  machine?: string | null;
  wasBlocked?: boolean;
  prevModel?: string | null;
  nextModel?: string | null;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!input.wasBlocked) return false;
  if (!String(input.prompt ?? '').trim()) return false;
  const prev = String(input.prevModel ?? '').trim();
  const next = String(input.nextModel ?? '').trim();
  return Boolean(next && next !== prev);
}

export function retryAfterModelSwitchToast(): string {
  return '已换模型，并把上一句发出去';
}
