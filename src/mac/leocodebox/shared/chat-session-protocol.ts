/** Additive /ws contract. Harness SSE on iOS/Python remains independent. */
export type ChatCursor = { runId: string; seq: number };

export type ChatQueueState = 'queued' | 'needs_confirmation' | 'running' | 'completed' | 'cancelled' | 'failed';
export type ChatQueueItem = {
  id: string;
  sessionId: string;
  clientRequestId: string;
  content: string;
  state: ChatQueueState;
  createdAt: number;
  reason: string | null;
  attachmentCount: number;
  model?: string;
  permissionMode?: string;
};

export const CHAT_QUEUE_PROTOCOL_VERSION = 2;
export const CHAT_QUEUE_SESSION_LIMIT = 16;
export const CHAT_QUEUE_GLOBAL_LIMIT = 128;
export const CHAT_COMMAND_MAX_BYTES = 256 * 1024;
