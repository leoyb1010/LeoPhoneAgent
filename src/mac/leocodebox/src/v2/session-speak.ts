import type { FlowRow } from './model';
import { lastAiReply } from './session-reply';

export const SPEAK_TEXT_MAX = 1800;

export function clipSpeakText(raw?: string | null, limit = SPEAK_TEXT_MAX): string {
  const next = (raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!next) return '';
  if (next.length <= limit) return next;
  return `${next.slice(0, limit)} 后面还有`;
}

export function canSpeakLastReply(machine?: string | null, rows?: readonly FlowRow[] | null): boolean {
  return machine === 'local' && Boolean(clipSpeakText(lastAiReply(rows)));
}

export function speakLastReplyToast(): string {
  return '正在读刚说的';
}
