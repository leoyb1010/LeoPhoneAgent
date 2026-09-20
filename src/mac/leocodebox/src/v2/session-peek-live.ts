import { samePeekFile } from './session-peek-sync';

export function canPeekLiveEdit(input: {
  machine?: string | null;
  status?: string | null;
  dirty?: boolean;
  focusFile?: string | null;
  liveFile?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'running' && input.status !== 'starting') return false;
  if (input.dirty) return false;
  const file = String(input.liveFile ?? '').trim();
  if (!file) return false;
  return !samePeekFile(input.focusFile, file);
}
