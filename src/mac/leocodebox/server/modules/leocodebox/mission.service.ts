/**
 * Mission cards (L4). A kanban card is a unit of parallel agent work: a goal,
 * an assigned agent profile (→ provider + routing slot), an isolated worktree,
 * and the session running in it. The card state machine drives the fleet —
 * starting a card spins up a worktree + bound session; finishing merges or
 * discards it. Cards are user-scoped.
 *
 * Flow: backlog → running → review → done | discarded (with reset/retry edges).
 */
import { randomUUID } from 'node:crypto';

import {
  agentProfilesDb,
  missionCardsDb,
  sessionsDb,
  type MissionCard,
  type MissionStatus,
} from '../database/index.js';

import { resolveSlotForSession } from './provider-routing.service.js';
import { sanitizeSlotId } from './provider-store.service.js';
import { createWorktree, discardWorktree } from './worktree.service.js';

type StatusError = Error & { statusCode?: number };
function fail(message: string, statusCode = 400): StatusError {
  const error: StatusError = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Full state graph. Side-effect edges (→running / →done / →discarded) are only
 * reachable through startCard / retryCard / completeCard / discardCard, which
 * do the worktree/session work. canTransition guards those methods. */
const ALLOWED: Record<MissionStatus, MissionStatus[]> = {
  backlog: ['running', 'discarded'],
  running: ['review', 'discarded'],
  review: ['done', 'running', 'discarded'],
  done: ['discarded'],
  discarded: [],
};

/** The ONLY pure-status edges the generic /transition route may perform.
 * Everything else must go through a dedicated side-effect method — otherwise a
 * raw {to:'running'} would create a "running" card with no worktree/session. */
const MANUAL_TRANSITIONS: Partial<Record<MissionStatus, MissionStatus[]>> = {
  running: ['review'],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function createMissionCard(userId: number, input: {
  projectPath: string; title: string; goal: string; profileId?: string; slot?: string;
}): MissionCard {
  const projectPath = String(input.projectPath || '').trim();
  const title = String(input.title || '').trim();
  const goal = String(input.goal || '').trim();
  if (!projectPath) throw fail('projectPath is required.');
  if (!title) throw fail('title is required.');
  if (!goal) throw fail('goal is required.');
  const profile = input.profileId ? agentProfilesDb.getProfile(userId, input.profileId) : null;
  const slot = input.slot ? sanitizeSlotId(input.slot) : '';
  return missionCardsDb.create(userId, {
    projectPath,
    title,
    goal,
    profileId: input.profileId ?? null,
    slot: slot || null,
    provider: profile?.provider ?? 'claude',
  });
}

export function listMissionCards(userId: number, projectPath?: string): MissionCard[] {
  return missionCardsDb.list(userId, projectPath);
}

/** Spin up the isolated worktree + a session bound to it. backlog → running. */
export async function startMissionCard(userId: number, cardId: string): Promise<MissionCard> {
  const card = missionCardsDb.get(userId, cardId);
  if (!card) throw fail('Unknown mission card.', 404);
  if (!canTransition(card.status, 'running')) throw fail(`Cannot start a card in status "${card.status}".`, 409);

  const profile = card.profileId ? agentProfilesDb.getProfile(userId, card.profileId) : null;
  const provider = profile?.provider ?? card.provider ?? 'claude';

  const slug = `${card.title || 'mission'}-${randomUUID().slice(0, 6)}`;
  const worktree = await createWorktree(card.projectPath, slug);

  // When the card doesn't pin a routing slot, auto-resolve one from the task
  // shape (long-context by goal size, etc.). Returns null unless the user has
  // bound slots, so plain setups stay on the active provider.
  let slot = card.slot;
  if (!slot && (provider === 'claude' || provider === 'codex')) {
    slot = await resolveSlotForSession({ target: provider, estimatedTokens: Math.ceil(card.goal.length / 4) });
  }

  const sessionId = randomUUID();
  sessionsDb.createAppSession(sessionId, provider, card.projectPath);
  sessionsDb.setWorktreeId(sessionId, worktree.id);
  if (slot) sessionsDb.setRoutingSlot(sessionId, slot);

  return missionCardsDb.patch(userId, cardId, {
    status: 'running',
    provider,
    worktreeId: worktree.id,
    sessionId,
    slot: slot ?? null,
  })!;
}

/** review → running with a fresh session bound to the existing worktree. */
export function retryMissionCard(userId: number, cardId: string, opts: { slot?: string } = {}): MissionCard {
  const card = missionCardsDb.get(userId, cardId);
  if (!card) throw fail('Unknown mission card.', 404);
  if (!canTransition(card.status, 'running')) throw fail(`Cannot retry a card in status "${card.status}".`, 409);
  if (!card.worktreeId) throw fail('Card has no worktree to retry in.', 409);

  const sessionId = randomUUID();
  sessionsDb.createAppSession(sessionId, card.provider, card.projectPath);
  sessionsDb.setWorktreeId(sessionId, card.worktreeId);
  const slot = opts.slot ?? card.slot ?? undefined;
  if (slot) sessionsDb.setRoutingSlot(sessionId, slot);

  return missionCardsDb.patch(userId, cardId, { status: 'running', sessionId, slot: slot ?? null })!;
}

/** Pure-status transition only (currently running→review). Side-effect edges
 * are rejected here and must use start/retry/complete/discard. */
export function transitionMissionCard(userId: number, cardId: string, to: MissionStatus): MissionCard {
  const card = missionCardsDb.get(userId, cardId);
  if (!card) throw fail('Unknown mission card.', 404);
  if (!(MANUAL_TRANSITIONS[card.status]?.includes(to))) {
    throw fail(`Transition ${card.status} → ${to} is not a manual status change; use start/retry/complete/discard.`, 409);
  }
  return missionCardsDb.patch(userId, cardId, { status: to })!;
}

/** review → done, freezing the observed cost snapshot. */
export function completeMissionCard(userId: number, cardId: string, costUsd?: number): MissionCard {
  const card = missionCardsDb.get(userId, cardId);
  if (!card) throw fail('Unknown mission card.', 404);
  if (!canTransition(card.status, 'done')) throw fail(`Cannot complete a card in status "${card.status}".`, 409);
  return missionCardsDb.patch(userId, cardId, {
    status: 'done',
    costUsd: Number.isFinite(costUsd) ? Number(costUsd) : card.costUsd,
  })!;
}

/** Any → discarded, tearing down the worktree. */
export async function discardMissionCard(userId: number, cardId: string, opts: { force?: boolean } = {}): Promise<MissionCard> {
  const card = missionCardsDb.get(userId, cardId);
  if (!card) throw fail('Unknown mission card.', 404);
  // Tear the worktree down FIRST: a dirty-worktree refusal throws here and the
  // card stays in place instead of half-transitioning to discarded.
  if (card.worktreeId) await discardWorktree(card.worktreeId, { force: opts.force });
  // Clear the now-dead worktree/session bindings so the card can't point at a
  // torn-down worktree.
  return missionCardsDb.patch(userId, cardId, { status: 'discarded', worktreeId: null, sessionId: null })!;
}

export function deleteMissionCard(userId: number, cardId: string): boolean {
  return missionCardsDb.delete(userId, cardId);
}
