export function canQueueWhileWaiting(input: {
  machine?: string | null;
  status?: string | null;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  return Boolean(String(input.prompt ?? '').trim());
}
