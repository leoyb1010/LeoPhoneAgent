import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { WebSocket } from 'ws';

import { logger } from '@/modules/logging/index.js';
import { getConnection, sessionsDb, worktreesDb } from '@/modules/database/index.js';
import { chatQueueDb, ChatQueueError, chatUserKey, type StoredChatQueueItem } from '@/modules/database/index.js';
import { CHAT_SERVER_EPOCH, chatRunRegistry, type ChatRun } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

import { CHAT_QUEUE_PROTOCOL_VERSION, type ChatCursor, type ChatQueueItem } from '../../../../shared/chat-session-protocol.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.leocodebox/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  }).map((descriptor) => ({ ...descriptor, path: path.resolve(assetsRoot, descriptor.path) }));
}

/**
 * One provider runtime entry point. All five runtimes share this signature,
 * which lets the chat handler dispatch through a provider-keyed map instead
 * of provider-specific branches.
 */
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: object
) => Promise<unknown>;

type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   */
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /** Claude-only today: pending tool approvals included in `chat_subscribed`. */
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  extra: AnyRecord = {},
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

const recoveredDatabases = new WeakSet<object>();

function prepareQueue(): void {
  const db = getConnection();
  if (recoveredDatabases.has(db)) return;
  chatQueueDb.recoverForEpoch(CHAT_SERVER_EPOCH);
  recoveredDatabases.add(db);
}

function queueSummary(item: StoredChatQueueItem): ChatQueueItem {
  return {
    id: item.id, sessionId: item.sessionId, clientRequestId: item.clientRequestId,
    content: item.content.length > 500 ? `${item.content.slice(0, 500)}…` : item.content,
    state: item.state, createdAt: item.createdAt, reason: item.reason,
    attachmentCount: normalizeImageDescriptors(item.options.images).length,
    model: typeof item.options.model === 'string' ? item.options.model : undefined,
    permissionMode: typeof item.options.permissionMode === 'string' ? item.options.permissionMode : undefined,
  };
}

function pendingQueue(sessionId: string, userId: string | number | null): ChatQueueItem[] {
  return chatQueueDb.listPending(userId, sessionId).map(queueSummary);
}

function broadcastQueue(sessionId: string, userId: string | number | null): void {
  chatRunRegistry.broadcast(sessionId, userId, {
    kind: 'chat_queue_updated', sessionId, queueItems: pendingQueue(sessionId, userId),
    timestamp: new Date().toISOString(),
  });
}

function assertRunOwner(sessionId: string, userId: string | number | null): void {
  const run = chatRunRegistry.getRun(sessionId);
  if (run && chatUserKey(run.userId) !== chatUserKey(userId)) throw new ChatQueueError('SESSION_ACCESS_DENIED');
}

/** Recheck queued references when executed: a file may have changed since upload. */
export async function validateQueuedImageReferences(images: unknown, assetsRootOverride?: string): Promise<AnyRecord[]> {
  const descriptors = normalizeImageDescriptors(images);
  if (descriptors.length === 0) return [];
  const root = await fs.realpath(assetsRootOverride ?? getGlobalImageAssetsDir());
  return Promise.all(descriptors.map(async (descriptor) => {
    const resolved = await fs.realpath(descriptor.path);
    if (path.dirname(resolved) !== root || !(await fs.stat(resolved)).isFile()) {
      throw new ChatQueueError('INVALID_ATTACHMENT');
    }
    return { ...descriptor, path: resolved };
  }));
}

async function executeCommand(item: StoredChatQueueItem, run: ChatRun, dependencies: ChatWebSocketDependencies): Promise<void> {
  try {
    const session = sessionsDb.getSessionById(item.sessionId);
    if (!session || session.isArchived) throw new ChatQueueError('SESSION_NOT_FOUND');
    const boundWorktreeId = sessionsDb.getWorktreeId(item.sessionId);
    const worktreeCwd = boundWorktreeId ? worktreesDb.get(boundWorktreeId)?.path : undefined;
    if (boundWorktreeId && !worktreeCwd) throw new ChatQueueError('WORKTREE_NOT_FOUND');
    const images = await validateQueuedImageReferences(item.options.images);
    // An abort may arrive while attachment validation is awaiting the filesystem.
    if (run.abortController.signal.aborted || chatRunRegistry.getRun(item.sessionId) !== run) return;
    await dependencies.spawnFns[run.provider](item.content, {
      ...item.options,
      images,
      appSessionId: item.sessionId,
      abortSignal: run.abortController.signal,
      sessionId: session.provider_session_id ?? undefined,
      resume: Boolean(session.provider_session_id),
      cwd: worktreeCwd ?? session.project_path ?? undefined,
      projectPath: worktreeCwd ?? session.project_path ?? undefined,
      routingSlot: sessionsDb.getRoutingSlot(item.sessionId) ?? undefined,
    }, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.writer.send({ kind: 'error', content: `任务未能完成：${message}`, provider: run.provider });
  } finally {
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1, aborted: run.abortController.signal.aborted });
    drainQueuedCommands(dependencies, item);
  }
}

/** Only serializable command data is stored. Connections are looked up by the run's observer set. */
function drainQueuedCommands(dependencies: ChatWebSocketDependencies, source?: { sessionId: string; userId: string | number | null }): void {
  let affected = source;
  try {
    for (const item of chatQueueDb.listReady(CHAT_SERVER_EPOCH)) {
      affected = item;
      if (!chatRunRegistry.canStart(item.sessionId)) continue;
      const session = sessionsDb.getSessionById(item.sessionId);
      const provider = session?.provider as LLMProvider | undefined;
      if (!session || session.isArchived || !provider || !dependencies.spawnFns[provider]) {
        chatQueueDb.failBeforeStart(item.id, 'SESSION_UNAVAILABLE');
        chatRunRegistry.broadcast(item.sessionId, item.userId, {
          kind: 'protocol_error', code: 'SESSION_UNAVAILABLE', error: '排队任务的会话已不可用。',
          sessionId: item.sessionId, clientRequestId: item.clientRequestId, isProcessing: false,
        });
        broadcastQueue(item.sessionId, item.userId);
        continue;
      }
      const run = chatRunRegistry.startRun({
        appSessionId: item.sessionId, provider, providerSessionId: session.provider_session_id,
        userId: item.userId, queueItemId: item.id,
      });
      if (!run) continue;
      // Once claimed durably, starting the command must not depend on a
      // subsequent queue-snapshot read or an observer's transport health.
      queueMicrotask(() => { void executeCommand(item, run, dependencies); });
      chatRunRegistry.broadcast(item.sessionId, item.userId, {
        kind: 'chat_run_started', sessionId: item.sessionId, runId: run.runId,
        cursor: { runId: run.runId, seq: run.initialSeq }, queueItemId: item.id,
        clientRequestId: item.clientRequestId, timestamp: new Date().toISOString(),
      });
      broadcastQueue(item.sessionId, item.userId);
    }
  } catch (error) {
    // A storage failure must never fall back to an in-memory, unacknowledged run.
    console.error('[Chat] Queue scheduling stopped because persistence is unavailable', error);
    if (affected) chatRunRegistry.broadcast(affected.sessionId, affected.userId, {
      kind: 'protocol_error', scope: 'queue', code: 'QUEUE_STORAGE_FAILED', sessionId: affected.sessionId,
      isProcessing: chatRunRegistry.isProcessing(affected.sessionId),
      error: '队列调度遇到存储错误，已接收的任务仍被保留。请核对当前运行状态后重试或取消。',
    });
  }
}

async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) { sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.'); return; }
  try {
    prepareQueue();
    assertRunOwner(sessionId, userId);
    const session = sessionsDb.getSessionById(sessionId);
    if (!session || session.isArchived) throw new ChatQueueError('SESSION_NOT_FOUND');
    if (!dependencies.spawnFns[session.provider as LLMProvider]) throw new ChatQueueError('UNSUPPORTED_PROVIDER');
    if (data.options != null && (typeof data.options !== 'object' || Array.isArray(data.options))) {
      throw new ChatQueueError('INVALID_OPTIONS');
    }
    const options = { ...(data.options ?? {}) } as AnyRecord;
    if (options.images != null && (!Array.isArray(options.images) || options.images.length > 5)) {
      throw new ChatQueueError('INVALID_ATTACHMENT');
    }
    const images = filterImagesToUploadStore(options.images);
    if (images.length !== (options.images?.length ?? 0)) throw new ChatQueueError('INVALID_ATTACHMENT');
    options.images = images;
    const accepted = chatQueueDb.accept({
      sessionId, userId,
      clientRequestId: typeof data.clientRequestId === 'string' ? data.clientRequestId : randomUUID(),
      content: typeof data.content === 'string' ? data.content : '', options, epoch: CHAT_SERVER_EPOCH,
    });
    chatRunRegistry.attachConnection(sessionId, ws, userId);
    sendJson(ws, {
      kind: 'chat_send_ack', sessionId, clientRequestId: accepted.item.clientRequestId,
      queueItemId: accepted.item.id, state: accepted.item.state, duplicate: accepted.duplicate,
      protocolVersion: CHAT_QUEUE_PROTOCOL_VERSION,
    });
    if (accepted.item.state === 'queued') {
      const queueItems = pendingQueue(sessionId, userId);
      sendJson(ws, { kind: 'chat_queued', sessionId, queueItemId: accepted.item.id,
        clientRequestId: accepted.item.clientRequestId, position: queueItems.findIndex((item) => item.id === accepted.item.id) + 1,
        queueItems, isProcessing: chatRunRegistry.isProcessing(sessionId), timestamp: new Date().toISOString() });
    }
    broadcastQueue(sessionId, userId);
    if (!accepted.duplicate) drainQueuedCommands(dependencies, accepted.item);
  } catch (error) {
    sendProtocolError(ws, error instanceof ChatQueueError ? error.code : 'QUEUE_STORAGE_FAILED',
      error instanceof Error ? error.message : '无法保存待运行任务。', sessionId,
      { clientRequestId: data.clientRequestId, isProcessing: chatRunRegistry.isProcessing(sessionId), scope: 'queue' });
  }
}

async function handleChatAbort(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) { sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.'); return; }
  assertRunOwner(sessionId, userId);
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', '当前会话没有正在运行的任务。', sessionId);
    return;
  }
  // Preserve the existing Stop semantics: clear this user's pending commands
  // BEFORE awaiting the runtime abort, so a finishing turn cannot start one.
  const pending = chatQueueDb.listPending(userId, sessionId);
  for (const item of pending) chatQueueDb.cancel(userId, sessionId, item.id);
  if (pending.length) chatRunRegistry.broadcast(sessionId, userId, { kind: 'chat_queue_cleared', sessionId, cleared: pending.length });
  broadcastQueue(sessionId, userId);
  run.abortController.abort();
  let success = false;
  try { success = Boolean(await dependencies.abortFns[run.provider]?.(run.providerSessionId || run.appSessionId)); }
  finally { chatRunRegistry.completeRunIfCurrent(run, { exitCode: success ? 0 : 1, aborted: true }); }
}

function readCursor(value: unknown): ChatCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.runId === 'string' && typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
    ? { runId: record.runId, seq: record.seq } : undefined;
}

function pendingApprovals(sessionId: string, dependencies: ChatWebSocketDependencies): AnyRecord[] {
  const run = chatRunRegistry.getRun(sessionId);
  const ids = [sessionId, run?.providerSessionId].filter((id): id is string => Boolean(id));
  const byRequest = new Map<string, AnyRecord>();
  for (const id of ids) {
    for (const approval of dependencies.getPendingApprovalsForSession(id)) {
      if (!approval || typeof approval !== 'object') continue;
      const record = approval as AnyRecord;
      if (typeof record.requestId !== 'string' || run?.resolvedApprovals.has(record.requestId)) continue;
      byRequest.set(record.requestId, { ...record, sessionId });
    }
  }
  return [...byRequest.values()];
}

function handleChatSubscribe(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  prepareQueue();
  const targets = Array.isArray(data.sessions) ? data.sessions.slice(0, 128) : [];
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    const sessionId = readRequiredSessionId(target as AnyRecord);
    if (!sessionId) continue;
    try { assertRunOwner(sessionId, userId); }
    catch { sendProtocolError(ws, 'SESSION_ACCESS_DENIED', '不能订阅其他用户的运行。', sessionId); continue; }
    if (!sessionsDb.getSessionById(sessionId)) { sendProtocolError(ws, 'SESSION_NOT_FOUND', '会话不存在。', sessionId); continue; }
    chatRunRegistry.attachConnection(sessionId, ws, userId);
    const lastSeq = typeof target.lastSeq === 'number' && Number.isSafeInteger(target.lastSeq) ? Math.max(0, target.lastSeq) : 0;
    const replay = chatRunRegistry.replayState(sessionId, lastSeq, readCursor(target.cursor));
    const isProcessing = chatRunRegistry.isProcessing(sessionId);
    sendJson(ws, {
      kind: 'chat_subscribed', sessionId, isProcessing,
      lastSeq: replay.cursor?.seq ?? 0, runId: replay.cursor?.runId ?? null, cursor: replay.cursor,
      serverEpoch: CHAT_SERVER_EPOCH, protocolVersion: CHAT_QUEUE_PROTOCOL_VERSION,
      replayFrom: replay.replayFrom, replayReset: replay.replayReset,
      replayTruncated: isProcessing && replay.replayTruncated,
      pendingPermissions: pendingApprovals(sessionId, dependencies), queueItems: pendingQueue(sessionId, userId),
      timestamp: new Date().toISOString(),
    });
    if (isProcessing) for (const event of replay.events) sendJson(ws, event);
  }
}

function handleQueueAction(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  prepareQueue();
  const sessionId = readRequiredSessionId(data);
  const itemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!sessionId || !itemId) { sendProtocolError(ws, 'QUEUE_ITEM_REQUIRED', '需要指定排队任务。'); return; }
  const action = data.type === 'chat.queue.resume' ? 'resume' : 'cancel';
  const result = action === 'resume' ? chatQueueDb.resume(userId, sessionId, itemId, CHAT_SERVER_EPOCH)
    : chatQueueDb.cancel(userId, sessionId, itemId);
  sendJson(ws, { kind: 'chat_queue_action_ack', sessionId, queueItemId: itemId, action, status: result });
  broadcastQueue(sessionId, userId);
  if (result === 'resumed') drainQueuedCommands(dependencies, { sessionId, userId });
}

function handlePermissionResponse(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || !data.requestId || typeof data.allow !== 'boolean') {
    sendProtocolError(ws, 'INVALID_APPROVAL', '需要有效的审批请求与明确的允许或拒绝。');
    return;
  }
  const candidates = chatRunRegistry.listRunningRuns().filter((run) => chatUserKey(run.userId) === chatUserKey(userId)
    && (!data.sessionId || data.sessionId === run.sessionId));
  for (const candidate of candidates) {
    const run = chatRunRegistry.getRun(candidate.sessionId)!;
    if (run.resolvedApprovals.has(data.requestId)) {
      sendJson(ws, { kind: 'chat_permission_ack', sessionId: candidate.sessionId, requestId: data.requestId, status: 'already_resolved' });
      return;
    }
    if (!pendingApprovals(candidate.sessionId, dependencies).some((item) => item.requestId === data.requestId)) continue;
    // Claim synchronously before invoking the resolver. A second observer can
    // neither overwrite this decision nor invoke the provider resolver twice.
    run.resolvedApprovals.add(data.requestId);
    try {
      dependencies.resolveToolApproval(data.requestId, {
        allow: data.allow, updatedInput: data.updatedInput,
        message: typeof data.message === 'string' ? data.message : undefined,
        rememberEntry: data.rememberEntry,
      });
    } catch (error) { run.resolvedApprovals.delete(data.requestId); throw error; }
    // Older clients and sidebar counters already understand permission_cancelled.
    run.writer.send({ kind: 'permission_cancelled', requestId: data.requestId, reason: 'resolved', provider: run.provider });
    chatRunRegistry.broadcast(candidate.sessionId, userId, {
      kind: 'permission_resolved', sessionId: candidate.sessionId, requestId: data.requestId,
      runId: run.runId, allow: data.allow,
    });
    sendJson(ws, { kind: 'chat_permission_ack', sessionId: candidate.sessionId, requestId: data.requestId, status: 'resolved',
      rememberEntry: data.allow && typeof data.rememberEntry === 'string' ? data.rememberEntry : undefined });
    return;
  }
  sendJson(ws, { kind: 'chat_permission_ack', sessionId: data.sessionId ?? null, requestId: data.requestId, status: 'not_pending' });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options?, clientRequestId? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq?, cursor? }] }
 * - `chat.unsubscribe`         { sessionId }
 * - `chat.queue.cancel/resume` { sessionId, queueItemId }
 * - `chat.permission-response` { sessionId?, requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  logger.info('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, userId, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(ws, userId, data, dependencies);
          return;
        case 'chat.queue.cancel':
        case 'chat.queue.resume':
          handleQueueAction(ws, userId, data, dependencies);
          return;
        case 'chat.unsubscribe':
          if (typeof data.sessionId === 'string') chatRunRegistry.detachConnection(ws, data.sessionId);
          return;
        case 'ping':
          // App-level heartbeat. Browsers cannot observe protocol ping/pong, so
          // the renderer sends this when idle and closes the socket itself if
          // the `pong` misses its deadline (half-open loopback after sleep).
          sendJson(ws, { kind: 'pong', timestamp: new Date().toISOString() });
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    logger.info('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    chatRunRegistry.detachConnection(ws);
  });
}
