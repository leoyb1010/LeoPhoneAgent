/**
 * Agent profiles repository (智能体档案).
 *
 * Each profile is a named launch preset — provider / model / effort /
 * permission mode + an optional opening prompt — persisted as a JSON blob per
 * row. Storing the payload as JSON means the profile shape can grow without a
 * schema migration; `normalizeAgentProfile` is the forward-compat layer that
 * coerces whatever is on disk back into the current shape on every read.
 */

import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider } from '@/shared/types.js';

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'grok'];

/** Editable payload of a profile (everything except server-owned id/timestamps). */
export type AgentProfileData = {
  name: string;
  emoji: string;
  provider: LLMProvider;
  model: string;
  effort: string;
  permissionMode: string;
  openingPrompt: string;
  notes: string;
};

/** A profile as returned to clients: payload + identity + timestamps. */
export type StoredAgentProfile = AgentProfileData & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const MAX_NAME = 120;
const MAX_SHORT = 80;
const MAX_LONG = 8000;

const clampString = (value: unknown, max: number, fallback = ''): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if ([...trimmed].length <= max) return trimmed;
  // Slice by code points so truncation never splits an astral pair into a lone surrogate.
  return [...trimmed].slice(0, max).join('');
};

/**
 * Coerce arbitrary parsed JSON into a valid AgentProfileData. Unknown providers
 * fall back to 'claude'; every string is trimmed and length-capped so a
 * malformed import can never bloat the row or inject an invalid provider.
 */
export function normalizeAgentProfile(value: unknown): AgentProfileData {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const providerInput = typeof source.provider === 'string' ? source.provider : '';
  return {
    name: clampString(source.name, MAX_NAME, '未命名档案'),
    emoji: clampString(source.emoji, 16, '🤖'),
    provider: PROVIDERS.includes(providerInput as LLMProvider) ? (providerInput as LLMProvider) : 'claude',
    model: clampString(source.model, MAX_SHORT, 'default'),
    effort: clampString(source.effort, MAX_SHORT),
    permissionMode: clampString(source.permissionMode, MAX_SHORT, 'default'),
    openingPrompt: clampString(source.openingPrompt, MAX_LONG),
    notes: clampString(source.notes, MAX_LONG),
  };
}

type Row = {
  profile_id: string;
  profile_json: string;
  created_at: string;
  updated_at: string;
};

const rowToProfile = (row: Row): StoredAgentProfile => {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.profile_json);
  } catch {
    parsed = {};
  }
  return {
    ...normalizeAgentProfile(parsed),
    id: row.profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const agentProfilesDb = {
  /** All of a user's profiles, most-recently-updated first. */
  listProfiles(userId: number): StoredAgentProfile[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT profile_id, profile_json, created_at, updated_at
         FROM agent_profiles WHERE user_id = ?
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(userId) as Row[];
    return rows.map(rowToProfile);
  },

  /** One profile by id, scoped to the owner. Null if it doesn't exist for them. */
  getProfile(userId: number, id: string): StoredAgentProfile | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT profile_id, profile_json, created_at, updated_at
         FROM agent_profiles WHERE user_id = ? AND profile_id = ?`,
      )
      .get(userId, id) as Row | undefined;
    return row ? rowToProfile(row) : null;
  },

  /** Create a profile with a fresh id; returns the stored (normalized) value. */
  createProfile(userId: number, input: unknown): StoredAgentProfile {
    const db = getConnection();
    const id = randomUUID();
    const data = normalizeAgentProfile(input);
    db.prepare(
      `INSERT INTO agent_profiles (profile_id, user_id, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(id, userId, JSON.stringify(data));
    return agentProfilesDb.getProfile(userId, id)!;
  },

  /** Overwrite a profile's payload; returns the updated value, or null if absent. */
  updateProfile(userId: number, id: string, input: unknown): StoredAgentProfile | null {
    const db = getConnection();
    const data = normalizeAgentProfile(input);
    const result = db
      .prepare(
        `UPDATE agent_profiles SET profile_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND profile_id = ?`,
      )
      .run(JSON.stringify(data), userId, id);
    if (result.changes === 0) return null;
    return agentProfilesDb.getProfile(userId, id);
  },

  /** Delete a profile. Returns true if a row was removed. */
  deleteProfile(userId: number, id: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM agent_profiles WHERE user_id = ? AND profile_id = ?')
      .run(userId, id);
    return result.changes > 0;
  },

  /** Bulk-create profiles from an import payload; each gets a new id. */
  importProfiles(userId: number, inputs: unknown[]): StoredAgentProfile[] {
    const db = getConnection();
    const insert = db.prepare(
      `INSERT INTO agent_profiles (profile_id, user_id, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    const created: string[] = [];
    const tx = db.transaction((items: unknown[]) => {
      for (const item of items) {
        const id = randomUUID();
        insert.run(id, userId, JSON.stringify(normalizeAgentProfile(item)));
        created.push(id);
      }
    });
    tx(inputs);
    return created.map((id) => agentProfilesDb.getProfile(userId, id)!);
  },
};
