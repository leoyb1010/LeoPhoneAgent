import { samePeekFile } from './session-peek-sync';

/** 正在写时预览跟上即将落地的正文，不写脏稿。2.1.89 只在等批准时 overlay。 */
export function canShowLiveProposal(input: {
  machine?: string | null;
  status?: string | null;
  dirty?: boolean;
  focusFile?: string | null;
  liveFile?: string | null;
  content?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (input.status !== 'running' && input.status !== 'starting') return false;
  if (input.dirty) return false;
  if (!String(input.content ?? '')) return false;
  return samePeekFile(input.focusFile, input.liveFile);
}
