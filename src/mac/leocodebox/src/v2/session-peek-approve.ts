import { samePeekFile } from './session-peek-sync';

export function shouldDropDirtyPeekOnApprove(input: {
  machine?: string | null;
  sameSession?: boolean;
  choice?: string | null;
  dirty?: boolean;
  focusFile?: string | null;
  pendingFile?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!input.sameSession) return false;
  const choice = String(input.choice ?? '');
  if (!choice || choice === 'deny') return false;
  if (!input.dirty) return false;
  return samePeekFile(input.focusFile, input.pendingFile);
}
