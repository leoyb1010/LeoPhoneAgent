export function canResumeThenSend(input: {
  machine?: string | null;
  canResume?: boolean;
  prompt?: string | null;
}): boolean {
  return input.machine === 'local' && Boolean(input.canResume) && Boolean(String(input.prompt ?? '').trim());
}

export function resumeThenSendLabel(): string {
  return '接着发出去';
}

export function resumeThenSendToast(): string {
  return '已接着这条，并把这句话发出去';
}
