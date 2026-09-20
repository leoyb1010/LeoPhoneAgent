export function canOpenIdleSession(machine?: string | null): boolean {
  return machine === 'local';
}

export function canSubmitNewSession(machine?: string | null, prompt?: string | null): boolean {
  if (String(prompt ?? '').trim()) return true;
  return canOpenIdleSession(machine);
}

export function openIdleLabel(hasPrompt: boolean): string {
  return hasPrompt ? '开始' : '先开着';
}

export function openIdleToast(): string {
  return '目录已开着，第一句随时说';
}
