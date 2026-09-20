export function canApproveOnEnter(input: {
  machine?: string | null;
  status?: string | null;
  pendingCount?: number;
  askFirst?: boolean;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  if (input.askFirst) return false;
  return (input.pendingCount ?? 0) >= 1;
}
