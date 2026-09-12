import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  CHAT_COMMAND_MAX_BYTES,
  CHAT_QUEUE_GLOBAL_LIMIT,
  CHAT_QUEUE_SESSION_LIMIT,
  type ChatQueueState,
} from '../../../../shared/chat-session-protocol.js';

export type SessionRuntimeState = {
  session_id: string;
  status: 'running' | 'completed' | 'aborted';
  provider: LLMProvider;
  started_at: number | null;
  finished_at: number | null;
  aborted: number;
  updated_at: string;
};

export const sessionRuntimeStateDb = {
  markRunning(sessionId: string, provider: LLMProvider, startedAt: number): void {
    getConnection().prepare(`
      INSERT INTO session_runtime_state (session_id, status, provider, started_at, finished_at, aborted, updated_at)
      VALUES (?, 'running', ?, ?, NULL, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET status = 'running', provider = excluded.provider,
        started_at = excluded.started_at, finished_at = NULL, aborted = 0, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, startedAt);
  },
  markFinished(sessionId: string, status: 'completed' | 'aborted', finishedAt: number): void {
    getConnection().prepare(`UPDATE session_runtime_state SET status = ?, finished_at = ?, aborted = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?`).run(status, finishedAt, status === 'aborted' ? 1 : 0, sessionId);
  },
  listRecoverable(): SessionRuntimeState[] {
    return getConnection().prepare(`SELECT * FROM session_runtime_state WHERE status = 'running' ORDER BY started_at ASC`).all() as SessionRuntimeState[];
  },
};

export type ChatQueueCommand = {
  sessionId: string;
  userId: string | number | null;
  clientRequestId: string;
  content: string;
  options: Record<string, unknown>;
  epoch: string;
};

export type StoredChatQueueItem = ChatQueueCommand & {
  id: string;
  state: ChatQueueState;
  runId: string | null;
  reason: string | null;
  createdAt: number;
};

type QueueRow = {
  id: string; session_id: string; user_key: string; client_request_id: string;
  content: string; options_json: string; state: ChatQueueState; worker_epoch: string;
  run_id: string | null; reason: string | null; created_at: number;
};

export class ChatQueueError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const chatUserKey = (userId: string | number | null): string => userId === null ? 'local' : `user:${userId}`;

function readQueueRow(row: QueueRow): StoredChatQueueItem {
  return {
    id: row.id, sessionId: row.session_id,
    userId: row.user_key === 'local' ? null : row.user_key.slice(5),
    clientRequestId: row.client_request_id, content: row.content,
    options: JSON.parse(row.options_json) as Record<string, unknown>,
    state: row.state, epoch: row.worker_epoch, runId: row.run_id,
    reason: row.reason, createdAt: row.created_at,
  };
}

/** Uses the application's existing SQLite connection and schema lifecycle. */
export const chatQueueDb = {
  accept(command: ChatQueueCommand): { item: StoredChatQueueItem; duplicate: boolean } {
    const optionsJson = JSON.stringify(command.options);
    if (!command.content.trim() || Buffer.byteLength(command.content) + Buffer.byteLength(optionsJson) > CHAT_COMMAND_MAX_BYTES) {
      throw new ChatQueueError('INVALID_COMMAND_SIZE');
    }
    if (!command.clientRequestId || command.clientRequestId.length > 200) throw new ChatQueueError('INVALID_REQUEST_ID');
    const db = getConnection();
    return db.transaction(() => {
      const userKey = chatUserKey(command.userId);
      const previous = db.prepare('SELECT * FROM chat_queue_items WHERE user_key = ? AND client_request_id = ?')
        .get(userKey, command.clientRequestId) as QueueRow | undefined;
      if (previous) {
        if (previous.session_id !== command.sessionId || previous.content !== command.content || previous.options_json !== optionsJson) {
          throw new ChatQueueError('REQUEST_ID_CONFLICT');
        }
        return { item: readQueueRow(previous), duplicate: true };
      }
      const counts = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN session_id = ? AND user_key = ? THEN 1 ELSE 0 END) AS session_count
        FROM chat_queue_items WHERE state IN ('queued', 'needs_confirmation')`)
        .get(command.sessionId, userKey) as { total: number; session_count: number | null };
      if (counts.total >= CHAT_QUEUE_GLOBAL_LIMIT || (counts.session_count ?? 0) >= CHAT_QUEUE_SESSION_LIMIT) {
        throw new ChatQueueError('QUEUE_FULL');
      }
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`INSERT INTO chat_queue_items
        (id,session_id,user_key,client_request_id,content,options_json,state,worker_epoch,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'queued',?,?,?)`)
        .run(id, command.sessionId, userKey, command.clientRequestId, command.content, optionsJson, command.epoch, now, now);
      return { item: { ...command, id, state: 'queued' as const, runId: null, reason: null, createdAt: now }, duplicate: false };
    })();
  },

  get(id: string): StoredChatQueueItem | null {
    const row = getConnection().prepare('SELECT * FROM chat_queue_items WHERE id = ?').get(id) as QueueRow | undefined;
    return row ? readQueueRow(row) : null;
  },

  listPending(userId: string | number | null, sessionId: string): StoredChatQueueItem[] {
    const rows = getConnection().prepare(`SELECT * FROM chat_queue_items
      WHERE user_key = ? AND session_id = ? AND state IN ('queued','needs_confirmation') ORDER BY ordinal`)
      .all(chatUserKey(userId), sessionId) as QueueRow[];
    return rows.map(readQueueRow);
  },

  listReady(epoch: string): StoredChatQueueItem[] {
    const rows = getConnection().prepare(`SELECT * FROM chat_queue_items
      WHERE state = 'queued' AND worker_epoch = ? ORDER BY ordinal LIMIT ?`)
      .all(epoch, CHAT_QUEUE_GLOBAL_LIMIT) as QueueRow[];
    return rows.map(readQueueRow);
  },

  markRunning(id: string, runId: string, epoch: string): boolean {
    return getConnection().prepare(`UPDATE chat_queue_items SET state = 'running',run_id = ?,updated_at = ?
      WHERE id = ? AND state = 'queued' AND worker_epoch = ?`)
      .run(runId, Date.now(), id, epoch).changes === 1;
  },

  finish(id: string, state: 'completed' | 'cancelled' | 'failed'): void {
    getConnection().prepare(`UPDATE chat_queue_items SET state = ?,updated_at = ? WHERE id = ? AND state = 'running'`)
      .run(state, Date.now(), id);
  },

  failBeforeStart(id: string, reason: string): void {
    getConnection().prepare(`UPDATE chat_queue_items SET state = 'failed',reason = ?,updated_at = ? WHERE id = ? AND state = 'queued'`)
      .run(reason, Date.now(), id);
  },

  cancel(userId: string | number | null, sessionId: string, id: string): 'cancelled' | 'already_started' | 'not_found' {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT state FROM chat_queue_items WHERE id = ? AND user_key = ? AND session_id = ?')
        .get(id, chatUserKey(userId), sessionId) as { state: ChatQueueState } | undefined;
      if (!row) return 'not_found';
      if (row.state === 'running') return 'already_started';
      if (!['queued', 'needs_confirmation', 'cancelled'].includes(row.state)) return 'already_started';
      db.prepare(`UPDATE chat_queue_items SET state = 'cancelled',updated_at = ? WHERE id = ?`).run(Date.now(), id);
      return 'cancelled';
    })();
  },

  resume(userId: string | number | null, sessionId: string, id: string, epoch: string): 'resumed' | 'not_pending' {
    const changed = getConnection().prepare(`UPDATE chat_queue_items SET state = 'queued',worker_epoch = ?,run_id = NULL,
      reason = NULL,updated_at = ? WHERE id = ? AND user_key = ? AND session_id = ? AND state = 'needs_confirmation'`)
      .run(epoch, Date.now(), id, chatUserKey(userId), sessionId).changes;
    return changed === 1 ? 'resumed' : 'not_pending';
  },

  recoverForEpoch(epoch: string): void {
    getConnection().prepare(`UPDATE chat_queue_items
      SET reason = CASE WHEN state = 'running' THEN 'server_restarted_during_run' ELSE 'server_restarted_before_run' END,
          state = 'needs_confirmation',updated_at = ?
      WHERE worker_epoch <> ? AND state IN ('queued','running')`).run(Date.now(), epoch);
  },

  reserveSequenceRange(sessionId: string, size: number): { start: number; end: number } {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare(`INSERT INTO chat_session_cursors(session_id,high_water) VALUES (?,?)
        ON CONFLICT(session_id) DO UPDATE SET high_water = high_water + excluded.high_water RETURNING high_water`)
        .get(sessionId, size) as { high_water: number };
      if (!Number.isSafeInteger(row.high_water)) throw new Error('CHAT_SEQUENCE_EXHAUSTED');
      return { start: row.high_water - size, end: row.high_water };
    })();
  },
};
