import type { FlowRow } from './model';
import { canExportSession } from './session-export';

export function canCopyTalk(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return canExportSession(machine, rows);
}

export function copyTalkToast(): string {
  return '已复制这次对话';
}
