export function sessionApproveChoice(choices?: readonly string[] | null): 'session' | 'always' | '' {
  const set = new Set(choices ?? []);
  if (set.has('session')) return 'session';
  if (set.has('always')) return 'always';
  return '';
}

export function canApproveForSession(input: {
  machine?: string | null;
  status?: string | null;
  choices?: readonly string[] | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'waiting_for_approval') return false;
  return Boolean(sessionApproveChoice(input.choices));
}
