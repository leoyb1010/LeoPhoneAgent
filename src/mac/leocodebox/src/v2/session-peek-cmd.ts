export function canSendFromPeek(input: {
  machine?: string | null;
  drawer?: string | null;
  composerFocused?: boolean;
  prompt?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.drawer !== 'files' && input.drawer !== 'diff') return false;
  if (input.composerFocused) return false;
  return Boolean(String(input.prompt ?? '').trim());
}
