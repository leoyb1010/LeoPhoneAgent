export function canQueueAfterApprove(input: {
  machine?: string | null;
  sameSession?: boolean;
  status?: string | null;
  choice?: string | null;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!input.sameSession) return false;
  if (input.choice !== 'once') return false;
  if (input.status !== 'waiting_for_approval') return false;
  return Boolean(String(input.prompt ?? '').trim());
}

export function queueAfterApproveToast(): string {
  return '已准，并把这句话排上';
}
