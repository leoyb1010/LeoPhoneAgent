import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider } from '@/shared/types.js';

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
