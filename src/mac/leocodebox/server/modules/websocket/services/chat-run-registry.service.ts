import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection, projectsDb, sessionsDb, sessionRuntimeStateDb, chatQueueDb, ChatQueueError, chatUserKey  } from '@/modules/database/index.js';
import { usageDb, estimateUsageCostUsd } from '@/modules/usage/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

import type { ChatCursor } from '../../../../shared/chat-session-protocol.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
export type ChatRun = {
  appSessionId: string;
  runId: string;
  userId: string | number | null;
  queueItemId: string | null;
  initialSeq: number;
  sequenceLimit: number;
  resolvedApprovals: Set<string>;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  abortController: AbortController;
  tokenBudget: Record<string, unknown> | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;
const MAX_CONCURRENT_RUNS = Math.max(1, Number.parseInt(process.env.LEOCODEBOX_MAX_CONCURRENT_SESSIONS || '4', 10) || 4);

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();
export const CHAT_SERVER_EPOCH = randomUUID();
const SEQUENCE_BLOCK_SIZE = 4096;
const observers = new Map<string, Map<RealtimeClientConnection, string>>();
const disconnectedConnection: RealtimeClientConnection = { readyState: 3, send: () => undefined };

function addObserver(sessionId: string, connection: RealtimeClientConnection, userId: string | number | null): void {
  const subscribers = observers.get(sessionId) ?? new Map<RealtimeClientConnection, string>();
  subscribers.set(connection, chatUserKey(userId));
  observers.set(sessionId, subscribers);
}

function broadcastToObservers(sessionId: string, userId: string | number | null, message: unknown): void {
  const subscribers = observers.get(sessionId);
  if (!subscribers) return;
  const payload = JSON.stringify(message);
  const owner = chatUserKey(userId);
  for (const [connection, userKey] of subscribers) {
    if (connection.readyState !== WS_OPEN_STATE) { subscribers.delete(connection); continue; }
    if (userKey !== owner) continue;
    try { connection.send(payload); }
    catch { subscribers.delete(connection); }
  }
  if (subscribers.size === 0) observers.delete(sessionId);
}

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function evictRunLater(completedRun: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(completedRun.appSessionId) === completedRun && completedRun.status === 'completed') {
      runs.delete(completedRun.appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (runs.get(run.appSessionId) !== run || run.status === 'completed') {
    return null;
  }

  if (run.lastSeq >= run.sequenceLimit) {
    const range = chatQueueDb.reserveSequenceRange(run.appSessionId, SEQUENCE_BLOCK_SIZE);
    run.lastSeq = range.start;
    run.sequenceLimit = range.end;
  }
  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    runId: run.runId,
    seq: run.lastSeq,
    cursor: { runId: run.runId, seq: run.lastSeq },
  };

  if (message.kind === 'status' && message.tokenBudget && typeof message.tokenBudget === 'object') {
    run.tokenBudget = message.tokenBudget as Record<string, unknown>;
  }

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    if (run.abortController.signal.aborted) outbound.aborted = true;
    run.status = 'completed';
    run.completedAt = Date.now();
    try { sessionRuntimeStateDb.markFinished(run.appSessionId, outbound.aborted ? 'aborted' : 'completed', run.completedAt); }
    catch (error) {
      outbound.persistenceWarning = '任务已结束，但本机未能保存运行状态。请核对结果后再恢复任务。';
      console.error('[Chat] Could not persist runtime completion', error);
    }
    try {
      if (run.tokenBudget) {
        const session = sessionsDb.getSessionById(run.appSessionId);
        const inputTokens = Number(run.tokenBudget.inputTokens ?? 0) || 0;
        const outputTokens = Number(run.tokenBudget.outputTokens ?? 0) || 0;
        const cacheTokens = Number(run.tokenBudget.cacheTokens ?? run.tokenBudget.cacheReadTokens ?? 0) || 0;
        usageDb.record({
          projectPath: session?.project_path,
          provider: run.provider,
          model: typeof run.tokenBudget.model === 'string' ? run.tokenBudget.model : null,
          inputTokens,
          outputTokens,
          cacheTokens,
          costUsd: estimateUsageCostUsd(run.provider, typeof run.tokenBudget.model === 'string' ? run.tokenBudget.model : null, inputTokens, outputTokens),
        });
      }
    } catch (error) {
      outbound.persistenceWarning = '任务已结束，但用量未能写入本机记录。';
      console.error('[Chat] Could not persist usage', error);
    }
    if (run.queueItemId) {
      try {
        chatQueueDb.finish(run.queueItemId, outbound.aborted ? 'cancelled'
          : (message.success === false || Number(message.exitCode ?? 0) !== 0) ? 'failed' : 'completed');
      } catch (error) {
        outbound.persistenceWarning = '任务已结束，但本机未能保存执行状态。重新启动后请核对结果再恢复。';
        console.error('[Chat] Could not persist command completion', error);
      }
    }
    evictRunLater(run);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (runs.get(run.appSessionId) !== run
    || !providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection?: RealtimeClientConnection;
    userId: string | number | null;
    queueItemId?: string;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') return null;
    const activeRuns = Array.from(runs.values()).filter((run) => run.status === 'running').length;
    if (activeRuns >= MAX_CONCURRENT_RUNS) return null;

    const runId = `${CHAT_SERVER_EPOCH}:${randomUUID()}`;
    const range = getConnection().transaction(() => {
      const reserved = chatQueueDb.reserveSequenceRange(input.appSessionId, SEQUENCE_BLOCK_SIZE);
      if (input.queueItemId && !chatQueueDb.markRunning(input.queueItemId, runId, CHAT_SERVER_EPOCH)) {
        throw new ChatQueueError('QUEUE_ITEM_UNAVAILABLE');
      }
      return reserved;
    })();
    if (input.connection) addObserver(input.appSessionId, input.connection, input.userId);
    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId,
      userId: input.userId,
      queueItemId: input.queueItemId ?? null,
      initialSeq: range.start,
      sequenceLimit: range.end,
      resolvedApprovals: new Set(),
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: range.start,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
      abortController: new AbortController(),
      tokenBudget: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection ?? disconnectedConnection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
      forward: (message) => broadcastToObservers(run.appSessionId, run.userId, message),
    });

    runs.set(input.appSessionId, run);
    try { sessionRuntimeStateDb.markRunning(input.appSessionId, input.provider, run.startedAt); } catch { /* runtime state is best-effort */ }
    return run;
  },

  canStart(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status !== 'running'
      && Array.from(runs.values()).filter((run) => run.status === 'running').length < MAX_CONCURRENT_RUNS;
  },

  broadcast(appSessionId: string, userId: string | number | null, message: unknown): void {
    broadcastToObservers(appSessionId, userId, message);
  },

  detachConnection(connection: RealtimeClientConnection, appSessionId?: string): void {
    for (const [sessionId, subscribers] of observers) {
      if (appSessionId && appSessionId !== sessionId) continue;
      subscribers.delete(connection);
      if (subscribers.size === 0) observers.delete(sessionId);
    }
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    runId: string;
    userId: string | number | null;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
        runId: run.runId,
        userId: run.userId,
      }));
  },

  /**
   * Re-attaches a run's outbound stream to a (new) websocket connection.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection, userId?: string | number | null): boolean {
    const run = runs.get(appSessionId);
    const owner = userId === undefined ? run?.userId ?? null : userId;
    if (run && chatUserKey(run.userId) !== chatUserKey(owner)) return false;
    addObserver(appSessionId, connection, owner);
    return Boolean(run);
  },

  replayState(appSessionId: string, legacySeq: number, cursor?: ChatCursor): {
    cursor: ChatCursor | null; replayFrom: number; replayReset: boolean; replayTruncated: boolean; events: NormalizedMessage[];
  } {
    const run = runs.get(appSessionId);
    if (!run) return { cursor: null, replayFrom: 0, replayReset: Boolean(cursor), replayTruncated: false, events: [] };
    const changedRun = Boolean(cursor && cursor.runId !== run.runId);
    const requested = cursor?.seq ?? legacySeq;
    const afterSeq = changedRun || requested > run.lastSeq ? run.initialSeq : Math.max(run.initialSeq, requested);
    return {
      cursor: { runId: run.runId, seq: run.lastSeq },
      replayFrom: afterSeq,
      replayReset: changedRun || requested > run.lastSeq,
      replayTruncated: this.isReplayTruncated(appSessionId, afterSeq),
      events: this.replayEvents(appSessionId, afterSeq),
    };
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > Math.max(run.initialSeq, afterSeq));
  },

  /**
   * True when the client missed events that the buffer no longer holds:
   * the run has advanced past `afterSeq`, but the oldest buffered event is
   * already newer than `afterSeq + 1`. Long tool-heavy runs (> 5000 events)
   * hit this on every reconnect; without the flag the transcript silently
   * gaps and the user sees a conversation that "won't load".
   */
  isReplayTruncated(appSessionId: string, afterSeq: number): boolean {
    const run = runs.get(appSessionId);
    if (!run || run.lastSeq <= afterSeq) {
      return false;
    }
    const oldestBuffered = run.events[0]?.seq;
    return typeof oldestBuffered !== 'number' || oldestBuffered > Math.max(run.initialSeq, afterSeq) + 1;
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
    observers.clear();
  },
};
