export function canApproveOnEnter(input: {
  machine?: string | null;
  status?: string | null;
  pendingCount?: number;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  return (input.pendingCount ?? 0) >= 1;
}
