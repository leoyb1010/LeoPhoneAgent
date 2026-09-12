import type { ChatCursor } from '../../../../shared/chat-session-protocol';
import type { ServerEvent } from '../../../contexts/WebSocketContext';

function eventCursor(event: ServerEvent): ChatCursor | undefined {
  const candidate = event.cursor && typeof event.cursor === 'object'
    ? event.cursor as Record<string, unknown> : event;
  return typeof candidate.runId === 'string' && typeof candidate.seq === 'number'
    && Number.isSafeInteger(candidate.seq) && candidate.seq >= 0
    ? { runId: candidate.runId, seq: candidate.seq } : undefined;
}

/** Ack watermarks describe the server head, not what the client has received. */
export function advanceChatCursor(current: ChatCursor | undefined, event: ServerEvent): {
  cursor: ChatCursor | undefined; accept: boolean; reset: boolean;
} {
  const incoming = eventCursor(event);
  if (!incoming) {
    const cleared = event.kind === 'chat_subscribed' && event.replayReset === true;
    return { cursor: cleared ? undefined : current, accept: true, reset: Boolean(cleared && current) };
  }
  const changed = current?.runId !== incoming.runId;
  if (event.kind === 'chat_subscribed' || event.kind === 'chat_run_started') {
    const replayFrom = typeof event.replayFrom === 'number' && Number.isSafeInteger(event.replayFrom)
      ? Math.max(0, event.replayFrom) : event.kind === 'chat_run_started' ? incoming.seq : 0;
    return {
      cursor: changed || event.replayReset ? { runId: incoming.runId, seq: replayFrom } : current,
      accept: true,
      reset: Boolean(current && (changed || event.replayReset)),
    };
  }
  if (!changed && current && incoming.seq <= current.seq) return { cursor: current, accept: false, reset: false };
  return { cursor: incoming, accept: true, reset: Boolean(current && changed) };
}
