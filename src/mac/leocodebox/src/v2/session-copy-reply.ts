import { lastAiReply } from './session-reply';
import type { FlowRow } from './model';

export function canCopyLastReply(rows?: readonly FlowRow[] | null): boolean {
  return Boolean(lastAiReply(rows));
}

export function copyLastReplyToast(): string {
  return '已复制模型刚说的';
}
