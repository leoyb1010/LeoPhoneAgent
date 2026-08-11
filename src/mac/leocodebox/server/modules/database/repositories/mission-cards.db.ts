import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type MissionStatus = 'backlog' | 'running' | 'review' | 'done' | 'discarded';

export type MissionCard = {
  id: string;
  projectPath: string;
  title: string;
  goal: string;
  profileId: string | null;
  slot: string | null;
  provider: string;
  worktreeId: string | null;
  sessionId: string | null;
  status: MissionStatus;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
};

export type MissionCardInput = {
  projectPath: string;
  title: string;
  goal: string;
  profileId?: string | null;
  slot?: string | null;
  provider?: string;
};

type Row = {
  card_id: string; project_path: string; title: string; goal: string;
  profile_id: string | null; slot: string | null; provider: string;
  worktree_id: string | null; session_id: string | null; status: string;
  cost_usd: number | null; created_at: string; updated_at: string;
};

const rowToCard = (row: Row): MissionCard => ({
  id: row.card_id,
  projectPath: row.project_path,
  title: row.title,
  goal: row.goal,
  profileId: row.profile_id,
  slot: row.slot,
  provider: row.provider,
  worktreeId: row.worktree_id,
  sessionId: row.session_id,
  status: row.status as MissionStatus,
  costUsd: row.cost_usd,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = 'SELECT card_id, project_path, title, goal, profile_id, slot, provider, worktree_id, session_id, status, cost_usd, created_at, updated_at FROM mission_cards';

export const missionCardsDb = {
  create(userId: number, input: MissionCardInput): MissionCard {
    const db = getConnection();
    const id = `mc-${randomUUID()}`;
    db.prepare(
      `INSERT INTO mission_cards (card_id, user_id, project_path, title, goal, profile_id, slot, provider, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(id, userId, input.projectPath, input.title, input.goal, input.profileId ?? null, input.slot ?? null, input.provider ?? 'claude');
    return missionCardsDb.get(userId, id)!;
  },
  get(userId: number, id: string): MissionCard | null {
    const row = getConnection().prepare(`${SELECT} WHERE user_id = ? AND card_id = ?`).get(userId, id) as Row | undefined;
    return row ? rowToCard(row) : null;
  },
  list(userId: number, projectPath?: string): MissionCard[] {
    const rows = projectPath
      ? getConnection().prepare(`${SELECT} WHERE user_id = ? AND project_path = ? ORDER BY updated_at DESC`).all(userId, projectPath)
      : getConnection().prepare(`${SELECT} WHERE user_id = ? ORDER BY updated_at DESC`).all(userId);
    return (rows as Row[]).map(rowToCard);
  },
  patch(userId: number, id: string, fields: Partial<Pick<MissionCard, 'status' | 'worktreeId' | 'sessionId' | 'provider' | 'slot' | 'costUsd'>>): MissionCard | null {
    const map: Record<string, string> = { status: 'status', worktreeId: 'worktree_id', sessionId: 'session_id', provider: 'provider', slot: 'slot', costUsd: 'cost_usd' };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (key in fields) { sets.push(`${column} = ?`); values.push((fields as Record<string, unknown>)[key] ?? null); }
    }
    if (sets.length === 0) return missionCardsDb.get(userId, id);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    const result = getConnection().prepare(`UPDATE mission_cards SET ${sets.join(', ')} WHERE user_id = ? AND card_id = ?`).run(...values, userId, id);
    return result.changes === 0 ? null : missionCardsDb.get(userId, id);
  },
  delete(userId: number, id: string): boolean {
    return getConnection().prepare('DELETE FROM mission_cards WHERE user_id = ? AND card_id = ?').run(userId, id).changes > 0;
  },
};
