import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import express from 'express';

import {
  treasuryDb,
  getDatabasePath,
  type RemoteTreasureChange,
  type RemoteTreasureMetadata,
  type TreasureItem,
} from '@/modules/database/index.js';

import { isLiveHarnessStatus } from './harness-session.service.js';
import { localMachineName, resolveRelayConfig } from './relay-client.service.js';

/**
 * [T-fleet-mac] 舰队视图与审批中心的后端。
 *
 * 手机上早就能"在一台设备上看另外两台、聚合所有待审批";Mac 端一直只
 * 知道自己。这里让 Mac 也走同一个中继去看整个舰队 —— 两端互为镜像,
 * 坐在任何一台前面都能掌握全局。
 *
 * 挂在 /api 之后(浏览器带 cookie 鉴权),不走 harness key:这是给
 * 本机 UI 用的,不是给手机用的。中继地址与钥匙从 ~/.leoagent/relay.json
 * 读,与 relay-client 同源。
 */

const router: express.Router = express.Router();

const REQUEST_TIMEOUT_MS = 15_000;
const ASSET_TIMEOUT_MS = 120_000;
const REMOTE_BODY_LIMIT = 8 * 1024 * 1024;
const REMOTE_ATTACHMENT_LIMIT = 128 * 1024 * 1024;
const SNAPSHOT_CACHE_MS = 3_000;
const ALLOWED_TREASURY_ASSET_MIMES = new Set([
  'application/json', 'application/msword', 'application/octet-stream',
  'application/pdf', 'application/rtf', 'application/vnd.apple.keynote',
  'application/vnd.apple.numbers', 'application/vnd.apple.pages',
  'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml', 'application/zip',
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
  'audio/wav', 'audio/x-m4a', 'audio/x-wav',
  'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/png',
  'image/tiff', 'image/webp',
  'text/csv', 'text/html', 'text/markdown', 'text/plain',
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
]);

export function publicTreasuryError(_error: unknown, fallback: string): string {
  // Treasury failures can originate in fs/fetch and may contain absolute paths,
  // relay URLs, or other machine-local details. Keep the HTTP/tool surface stable.
  return fallback;
}

type RelayTarget = { base: string; key: string };

function authenticatedUserId(req: express.Request): number {
  const value = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isInteger(value) || value <= 0) throw new Error('Authenticated user is missing');
  return value;
}

function treasuryScope(target: RelayTarget): string {
  return `relay:${createHash('sha256').update(target.base).digest('hex').slice(0, 24)}`;
}

function treasuryDeviceId(): string {
  return `mac:${localMachineName()}`.slice(0, 200);
}

/** 中继根地址(…/relay/api)。没配中继就返回 null,前端据此显示引导。 */
function relayTarget(): RelayTarget | null {
  const config = resolveRelayConfig();
  if (!config) return null;
  // relay-client 存的是 ws 地址(…/relay/agent),这里要 HTTP 根
  const httpBase = config.wsUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/relay\/agent$/, '/relay/api');
  return { base: httpBase, key: config.relayKey };
}

async function relayFetch(path: string, target: RelayTarget): Promise<unknown> {
  const res = await fetch(`${target.base}${path}`, {
    headers: { authorization: `Bearer ${target.key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return res.json();
}

class RelayHttpError extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(`relay ${status}`);
  }
}

async function relayJson(path: string, target: RelayTarget, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${target.base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${target.key}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new RelayHttpError(res.status, payload);
  return payload;
}

async function relayRaw(
  pathname: string,
  target: RelayTarget,
  deviceId: string,
  rangeStart = 0,
): Promise<Response> {
  return fetch(`${target.base}${pathname}`, {
    headers: {
      authorization: `Bearer ${target.key}`,
      'x-treasury-device-id': deviceId,
      ...(rangeStart > 0 ? { range: `bytes=${rangeStart}-` } : {}),
    },
    signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
  });
}

async function relayPost(path: string, target: RelayTarget, body: unknown): Promise<unknown> {
  const res = await fetch(`${target.base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return res.json();
}

type MachineRow = {
  name: string;
  online: boolean;
  reachable: boolean;
  platform?: string;
  server?: string;
  version?: string;
  activeCount: number;
  sessions: Array<Record<string, unknown>>;
};

type SnapshotMachine = {
  name: string;
  online: boolean;
  reachable: boolean;
  platform?: string;
  server?: string;
  version?: string;
  sessions: Array<Record<string, unknown>>;
};

type SnapshotCache = {
  base: string;
  key: string;
  expiresAt: number;
  promise: Promise<SnapshotMachine[]>;
};

let snapshotCache: SnapshotCache | null = null;

/** SSE `?after=N`：非法或负数按 0 回放，与本机 harness 路由同一语义。 */
export function parseEventsAfter(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? '0'), 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * 远程开会话的中继体。Android/Harmony minis 不要带上这台 Mac 的项目路径
 * 当 cwd——那边没有这份目录,长路径还会被 400。thinking 原样转发,minis
 * 按大小写不敏感解析。
 */
export function buildRemoteCreateBody(body: Record<string, unknown> | undefined, prompt: string): Record<string, unknown> {
  const harness = String(body?.harness ?? 'claude').trim() || 'claude';
  const payload: Record<string, unknown> = { harness, prompt };
  const thinking = typeof body?.thinking === 'string' ? body.thinking.trim() : '';
  if (thinking && thinking !== 'default') payload.thinking = thinking;
  if (harness !== 'minis' && typeof body?.cwd === 'string' && body.cwd.trim()) {
    payload.cwd = body.cwd;
  }
  return payload;
}

function sendBody(body: unknown): { text: string } | null {
  const text = typeof body === 'object' && body && 'text' in body
    ? String((body as { text?: unknown }).text ?? '').trim()
    : '';
  return text ? { text } : null;
}

/**
 * Fleet 与 approvals 是同屏并发请求。旧实现会各自拉一次 /machines，
 * 再把每台 Mac 的 sessions 也各拉一次；三台机器就是一次刷新 8 个中继
 * 请求。这个 3 秒 single-flight 快照让同屏请求复用同一轮真实数据，
 * 不改变 15 秒 UI 刷新语义，也不会把状态长期缓存。
 */
async function loadFleetSnapshot(target: RelayTarget, forceFresh = false): Promise<SnapshotMachine[]> {
  const now = Date.now();
  if (!forceFresh
    && snapshotCache
    && snapshotCache.base === target.base
    && snapshotCache.key === target.key
    && snapshotCache.expiresAt > now) {
    return snapshotCache.promise;
  }

  const promise = (async () => {
    const payload = (await relayFetch('/machines', target)) as {
      machines?: Array<{ name?: string; online?: boolean; platform?: string; server?: string; version?: string }>;
    };
    return Promise.all((payload.machines ?? []).map(async (machine): Promise<SnapshotMachine> => {
      const name = String(machine.name ?? '');
      const base: SnapshotMachine = {
        name,
        online: machine.online === true,
        reachable: false,
        platform: machine.platform,
        server: machine.server,
        version: machine.version,
        sessions: [],
      };
      if (!base.online) return base;
      try {
        const detail = (await relayFetch(
          `/m/${encodeURIComponent(name)}/harness/sessions`,
          target,
        )) as { sessions?: Array<Record<string, unknown>> };
        return { ...base, reachable: true, sessions: detail.sessions ?? [] };
      } catch {
        return base;
      }
    }));
  })();

  snapshotCache = {
    base: target.base,
    key: target.key,
    expiresAt: now + SNAPSHOT_CACHE_MS,
    promise,
  };
  try {
    return await promise;
  } catch (error) {
    if (snapshotCache?.promise === promise) snapshotCache = null;
    throw error;
  }
}

/** 舰队总览:每台机器 + 它上面的会话与待审批。 */
router.get('/leophone/fleet', async (_req, res) => {
  const target = relayTarget();
  const localName = localMachineName();
  if (!target) {
    res.json({ configured: false, localName, relayApiRoot: '', machines: [] });
    return;
  }
  try {
    const snapshot = await loadFleetSnapshot(target);
    const rows: MachineRow[] = snapshot.map((machine) => {
      const active = machine.sessions.filter((session) => isLiveHarnessStatus(String(session.status)));
      return {
        name: machine.name,
        online: machine.online,
        reachable: machine.reachable,
        platform: machine.platform,
        server: machine.server,
        version: machine.version,
        activeCount: active.length,
        sessions: active,
      };
    });
    res.json({ configured: true, localName, relayApiRoot: target.base, machines: rows });
  } catch (error) {
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'relay unreachable' },
    });
  }
});

/** 审批中心:把全舰队的待审批聚到一处。 */
router.get('/leophone/approvals', async (_req, res) => {
  const target = relayTarget();
  if (!target) {
    res.json({ configured: false, approvals: [] });
    return;
  }
  try {
    const snapshot = await loadFleetSnapshot(target);
    const approvals: Array<Record<string, unknown>> = [];
    for (const machine of snapshot) {
      if (!machine.online || !machine.reachable) continue;
      for (const session of machine.sessions) {
        const pending = (session.pending_approvals as Array<Record<string, unknown>>) ?? [];
        for (const approval of pending) {
          approvals.push({
            machine: machine.name,
            session_id: session.session_id,
            harness: session.harness,
            seq: session.seq ?? 0,
            approval_id: approval.approval_id,
            command: approval.command ?? '',
            choices: approval.choices ?? ['once', 'deny'],
          });
        }
      }
    }
    // 最近的排前面 —— 放行 shell 命令时默认选中的必须是最新那条
    approvals.sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0));
    res.json({ configured: true, approvals });
  } catch (error) {
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'relay unreachable' },
    });
  }
});

/** 应答一条审批。 */
router.post('/leophone/approvals/respond', async (req, res) => {
  const target = relayTarget();
  if (!target) {
    res.status(409).json({ error: { message: 'relay not configured' } });
    return;
  }
  const { machine, session_id: sessionId, approval_id: approvalId, choice } = req.body ?? {};
  if (![machine, sessionId, approvalId, choice].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
    res.status(400).json({ error: { message: 'machine/session_id/approval_id/choice required' } });
    return;
  }
  try {
    // Never proxy an arbitrary renderer-supplied choice. Re-read the live
    // approval and allow only the options advertised by that exact session.
    const snapshot = await loadFleetSnapshot(target, true);
    const targetMachine = snapshot.find((candidate) => candidate.name === machine);
    const targetSession = targetMachine?.sessions.find((session) => session.session_id === sessionId);
    const pending = Array.isArray(targetSession?.pending_approvals)
      ? targetSession.pending_approvals as Array<Record<string, unknown>>
      : [];
    const targetApproval = pending.find((approval) => approval.approval_id === approvalId);
    if (!targetApproval) {
      res.status(409).json({ error: { message: 'approval is no longer pending' } });
      return;
    }
    const allowedChoices = Array.isArray(targetApproval.choices)
      ? targetApproval.choices.filter((item): item is string => typeof item === 'string')
      : ['once', 'deny'];
    if (!allowedChoices.includes(choice)) {
      res.status(400).json({ error: { message: 'choice is not allowed for this approval' } });
      return;
    }

    const result = await relayPost(
      `/m/${encodeURIComponent(machine)}/harness/sessions/${encodeURIComponent(sessionId)}/approval`,
      target,
      { approval_id: approvalId, choice },
    );
    snapshotCache = null;
    res.json({ ok: true, result });
  } catch (error) {
    // 送不到就明说,不能让 UI 把卡片清掉而 CLI 还在等
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'approval not delivered' },
    });
  }
});

/**
 * [T-fleet-remote-run] 在某台远程 Mac 上开会话 / 驱动 / 接管。
 *
 * 工作台的指挥条把 @目标 切到远程时,以及会话列表里点「接管会话」时走这几条。
 * 全都是中继的薄代理:leocodebox 自己不复制一份远程会话状态,回放与实时跟随
 * 都由远端那台机器的 harness 事件日志负责(单调 seq,`?after=N` 续传不丢不重)。
 */
router.post('/leophone/fleet/sessions', async (req, res) => {
  const target = relayTarget();
  if (!target) {
    res.status(409).json({ error: { message: '未配置中继' } });
    return;
  }
  const machine = String(req.body?.machine ?? '').trim();
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!machine || !prompt) {
    res.status(400).json({ error: { message: 'machine 与 prompt 均为必填' } });
    return;
  }
  try {
    const created = await relayPost(
      `/m/${encodeURIComponent(machine)}/harness/sessions`,
      target,
      buildRemoteCreateBody((req.body ?? {}) as Record<string, unknown>, prompt),
    );
    snapshotCache = null;
    res.status(202).json(created);
  } catch (error) {
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'relay unreachable' },
    });
  }
});

/** 接管:先回放 `after` 之前的全部事件,再实时跟随。SSE 原样透传。 */
router.get('/leophone/fleet/machines/:machine/sessions/:sessionId/events', async (req, res) => {
  const target = relayTarget();
  if (!target) {
    res.status(409).json({ error: { message: '未配置中继' } });
    return;
  }
  const { machine, sessionId } = req.params;
  const after = parseEventsAfter(req.query.after);
  const upstream = new AbortController();
  // 客户端断开时一并掐掉上游,别把中继连接泄漏在那儿。
  req.on('close', () => upstream.abort());

  try {
    const relayRes = await fetch(
      `${target.base}/m/${encodeURIComponent(machine)}/harness/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
      {
        headers: { authorization: `Bearer ${target.key}`, accept: 'text/event-stream' },
        signal: upstream.signal,
      },
    );
    if (!relayRes.ok || !relayRes.body) {
      res.status(502).json({ error: { message: `relay ${relayRes.status}` } });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const reader = relayRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    if (upstream.signal.aborted) return;
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: error instanceof Error ? error.message : 'relay unreachable' },
      });
      return;
    }
    res.end();
  }
});

/** 接管后的多回合驾驶与叫停。 */
for (const action of ['send', 'stop'] as const) {
  router.post(`/leophone/fleet/machines/:machine/sessions/:sessionId/${action}`, async (req, res) => {
    const target = relayTarget();
    if (!target) {
      res.status(409).json({ error: { message: '未配置中继' } });
      return;
    }
    const { machine, sessionId } = req.params;
    try {
      const forwarded = action === 'send' ? sendBody(req.body) : {};
      if (action === 'send' && !forwarded) {
        res.status(400).json({ error: { message: 'text is required' } });
        return;
      }
      const result = await relayPost(
        `/m/${encodeURIComponent(machine)}/harness/sessions/${encodeURIComponent(sessionId)}/${action}`,
        target,
        forwarded ?? {},
      );
      snapshotCache = null;
      res.json(result);
    } catch (error) {
      res.status(502).json({
        error: { message: error instanceof Error ? error.message : 'relay unreachable' },
      });
    }
  });
}

/** Mint a short join token so a new phone can enter without pasting RELAY_KEY. */
router.post('/leophone/join-token', async (req, res) => {
  const target = relayTarget();
  if (!target) {
    res.status(409).json({ error: { message: 'relay not configured' } });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const machine = String(body.machine ?? localMachineName());
  try {
    const minted = await relayPost('/join-tokens', target, { machine }) as {
      token?: string;
      exp?: number;
    };
    res.json({ token: minted.token, exp: minted.exp, machine });
  } catch (error) {
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'relay unreachable' },
    });
  }
});

const REMOTE_KINDS = new Set(['link', 'text', 'note', 'image', 'document', 'audio', 'video', 'artifact']);
const REMOTE_READING = new Set(['none', 'unread', 'reading', 'read']);
const REMOTE_PROCESSING = new Set(['saved', 'queued', 'processing', 'ready', 'partial', 'failed']);
const remoteText = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
const remoteNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

function normalizeRemoteItem(value: unknown): RemoteTreasureMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = remoteText(raw.id, 200);
  const kind = remoteText(raw.kind, 20);
  const origin = remoteText(raw.origin_device_id, 200);
  const sourceUri = remoteText(raw.source_uri, 16_384);
  if (!id || !origin || !REMOTE_KINDS.has(kind)) return null;
  if (sourceUri) {
    try {
      const parsed = new URL(sourceUri);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    } catch { return null; }
  }
  const digest = remoteText(raw.content_digest, 64).toLowerCase();
  if (digest && !/^[0-9a-f]{64}$/.test(digest)) return null;
  const reading = remoteText(raw.reading_state, 20);
  const processing = remoteText(raw.processing_state, 20);
  const tags = Array.isArray(raw.tags) ? raw.tags.flatMap((entry) => {
    const text = remoteText(entry, 100); return text ? [text] : [];
  }).slice(0, 100) : [];
  const collectionIds = Array.isArray(raw.collection_ids)
    ? raw.collection_ids.flatMap((entry) => {
      const text = remoteText(entry, 200); return text ? [text] : [];
    }).slice(0, 100) : [];
  return {
    id, kind: kind as RemoteTreasureMetadata['kind'], title: remoteText(raw.title, 500),
    source_uri: sourceUri, source_app: remoteText(raw.source_app, 200),
    source_label: remoteText(raw.source_label, 500), summary: remoteText(raw.summary, 4_000),
    annotation: remoteText(raw.annotation, 20_000), tags, collection_ids: collectionIds,
    pinned: raw.pinned === true, archived: raw.archived === true,
    reading_state: (REMOTE_READING.has(reading) ? reading : 'none') as RemoteTreasureMetadata['reading_state'],
    reading_progress: Math.min(1, remoteNumber(raw.reading_progress)),
    created_at: remoteNumber(raw.created_at), updated_at: remoteNumber(raw.updated_at),
    last_opened_at: remoteNumber(raw.last_opened_at),
    processing_state: (REMOTE_PROCESSING.has(processing) ? processing : 'ready') as RemoteTreasureMetadata['processing_state'],
    processing_error_code: remoteText(raw.processing_error_code, 100),
    content_digest: digest, byte_count: Math.min(Number.MAX_SAFE_INTEGER, remoteNumber(raw.byte_count)),
    mime_type: remoteText(raw.mime_type, 200), body_available: raw.body_available === true,
    attachment_available: raw.attachment_available === true, origin_device_id: origin,
    deleted_at: remoteNumber(raw.deleted_at),
  };
}

function localSyncItem(item: TreasureItem): RemoteTreasureMetadata {
  const seconds = (raw: string | null): number => raw ? Date.parse(raw) / 1_000 : 0;
  return {
    id: item.id, kind: item.kind, title: item.title ?? '', source_uri: item.source_uri ?? '',
    source_app: item.source_app ?? '', source_label: item.source_label,
    summary: item.summary ?? '', annotation: item.annotation ?? '', tags: item.tags,
    collection_ids: item.collection_ids, pinned: item.pinned, archived: item.archived,
    reading_state: item.reading_state, reading_progress: item.reading_progress,
    created_at: seconds(item.created_at), updated_at: seconds(item.updated_at),
    last_opened_at: seconds(item.last_opened_at), processing_state: item.processing_state,
    processing_error_code: item.processing_error_code ?? '', content_digest: item.content_digest ?? '',
    byte_count: item.byte_count, mime_type: item.mime_type ?? '',
    body_available: item.original_text !== null,
    attachment_available: item.body_ref !== null && item.byte_count > 0,
    origin_device_id: treasuryDeviceId(), deleted_at: seconds(item.deleted_at),
  };
}

async function uploadLocalTreasury(userId: number, target: RelayTarget, scope: string): Promise<void> {
  const state = treasuryDb.remoteSyncState(scope);
  let cursor = state.uploadCursor;
  for (let page = 0; page < 20; page += 1) {
    const changes = treasuryDb.changes(cursor, 500);
    if (!changes.length) return;
    const items = treasuryDb.get(userId, changes.map((change) => change.item_id), true);
    const byId = new Map(items.map((item) => [item.id, item]));
    const payload = changes.map((change) => ({
      ...change,
      local_sequence: change.sequence,
      updated_at: Date.parse(change.updated_at) / 1_000,
      origin_device_id: treasuryDeviceId(),
      item: change.operation === 'upsert' && byId.has(change.item_id)
        ? localSyncItem(byId.get(change.item_id)!) : undefined,
    }));
    const response = await relayJson('/treasury/changes', target, {
      method: 'POST', body: JSON.stringify({ device_id: treasuryDeviceId(), changes: payload }),
    }) as { ack_local_cursor?: unknown };
    const ack = Math.max(cursor, Number(response.ack_local_cursor) || 0);
    if (ack <= cursor) throw new Error('relay did not acknowledge treasury changes');
    treasuryDb.setUploadCursor(scope, ack);
    cursor = ack;
    if (changes.length < 500) return;
  }
  throw new Error('local treasury sync page limit exceeded');
}

async function rebuildRemoteTreasury(target: RelayTarget, scope: string): Promise<void> {
  let after = 0;
  const items: Array<RemoteTreasureMetadata & { server_sequence: number }> = [];
  let serverCursor = 0;
  for (let page = 0; page < 60; page += 1) {
    const response = await relayJson(`/treasury/items?after_sequence=${after}&limit=1000`, target) as {
      items?: unknown[]; next_cursor?: unknown; has_more?: unknown; server_cursor?: unknown;
    };
    if (!Array.isArray(response.items)) throw new Error('relay treasury snapshot is missing');
    let pageCursor = after;
    for (const value of response.items) {
      if (!value || typeof value !== 'object') throw new Error('relay treasury snapshot is invalid');
      const normalized = normalizeRemoteItem(value);
      const sequence = remoteNumber((value as Record<string, unknown>)?.server_sequence);
      if (!normalized || sequence <= pageCursor) throw new Error('relay treasury snapshot is invalid');
      pageCursor = sequence;
      items.push({ ...normalized, server_sequence: sequence });
    }
    const next = remoteNumber(response.next_cursor);
    serverCursor = remoteNumber(response.server_cursor);
    if (next !== pageCursor || serverCursor < next) throw new Error('relay treasury snapshot cursor mismatch');
    if (response.has_more !== true) {
      treasuryDb.replaceRemoteSnapshot(scope, items, serverCursor);
      return;
    }
    if (next <= after) throw new Error('relay treasury rebuild cursor stalled');
    after = next;
  }
  throw new Error('remote treasury rebuild page limit exceeded');
}

async function pullRemoteTreasury(target: RelayTarget, scope: string): Promise<void> {
  let cursor = treasuryDb.remoteSyncState(scope).cursor;
  for (let page = 0; page < 40; page += 1) {
    let response: { changes?: unknown[]; next_cursor?: unknown; has_more?: unknown };
    try {
      response = await relayJson(`/treasury/changes?after=${cursor}&limit=500`, target) as typeof response;
    } catch (error) {
      if (error instanceof RelayHttpError && error.status === 410) {
        await rebuildRemoteTreasury(target, scope);
        return;
      }
      throw error;
    }
    if (!Array.isArray(response.changes)) throw new Error('relay treasury change list is missing');
    const changes: RemoteTreasureChange[] = [];
    let deliveredCursor = cursor;
    for (const value of response.changes) {
      if (!value || typeof value !== 'object') throw new Error('relay treasury change is invalid');
      const raw = value as Record<string, unknown>;
      const sequence = remoteNumber(raw.sequence);
      if (sequence <= deliveredCursor) throw new Error('relay treasury change order is invalid');
      deliveredCursor = sequence;
      if (raw.applied === false) continue;
      const operation = remoteText(raw.operation, 20);
      const item = raw.item == null ? null : normalizeRemoteItem(raw.item);
      const changeId = remoteText(raw.change_id, 200);
      const itemId = remoteText(raw.item_id, 200);
      const origin = remoteText(raw.origin_device_id, 200);
      const digest = remoteText(raw.payload_digest, 64).toLowerCase();
      if (!sequence || !changeId || !itemId || !origin || !['upsert', 'delete'].includes(operation) ||
          !/^[0-9a-f]{64}$/.test(digest) ||
          (operation === 'upsert' && (!item || item.id !== itemId || item.origin_device_id !== origin))) {
        throw new Error('relay treasury change is invalid');
      }
      changes.push({ sequence, change_id: changeId, item_id: itemId,
        operation: operation as 'upsert' | 'delete', updated_at: remoteNumber(raw.updated_at),
        origin_device_id: origin, payload_digest: digest, item });
    }
    const next = remoteNumber(response.next_cursor);
    if (next !== deliveredCursor) throw new Error('relay treasury cursor does not match delivered changes');
    treasuryDb.applyRemoteChanges(scope, changes, Math.max(cursor, next));
    if (response.has_more !== true) return;
    if (next <= cursor) throw new Error('relay treasury cursor stalled');
    cursor = next;
  }
  throw new Error('remote treasury page limit exceeded');
}

async function serveLocalTreasuryAssetRequests(userId: number, target: RelayTarget): Promise<void> {
  const deviceId = treasuryDeviceId();
  const response = await relayJson(
    `/treasury/assets/requests?origin_device_id=${encodeURIComponent(deviceId)}`, target,
  ) as { requests?: unknown[] };
  const root = path.join(path.dirname(getDatabasePath()), 'treasury');
  for (const value of (response.requests ?? []).slice(0, 10)) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    const requestId = remoteText(raw.id, 200);
    const itemId = remoteText(raw.item_id, 200);
    const assetKind = remoteText(raw.asset_kind, 20);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        !itemId || !['body', 'attachment'].includes(assetKind)) continue;
    const item = treasuryDb.get(userId, [itemId], true)[0];
    let bytes: Buffer | null = null;
    let filePath: string | null = null;
    let byteCount = 0;
    let digest = '';
    let mimeType = 'application/octet-stream';
    if (item && !item.deleted_at && assetKind === 'body' && item.original_text !== null) {
      bytes = Buffer.from(item.original_text, 'utf8');
      mimeType = 'text/plain';
      if (bytes.length > REMOTE_BODY_LIMIT) bytes = null;
      if (bytes) {
        byteCount = bytes.length;
        digest = createHash('sha256').update(bytes).digest('hex');
      }
    } else if (item && !item.deleted_at && assetKind === 'attachment' && item.body_ref) {
      const candidate = path.resolve(root, item.body_ref);
      const rootPrefix = path.resolve(root) + path.sep;
      if (candidate.startsWith(rootPrefix)) {
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile() && stat.size <= REMOTE_ATTACHMENT_LIMIT) {
            const fileDigest = await sha256File(candidate);
            if ((!item.content_digest || item.content_digest === fileDigest) &&
                (!item.byte_count || item.byte_count === stat.size)) {
              filePath = candidate;
              byteCount = stat.size;
              digest = fileDigest;
              mimeType = item.mime_type ?? 'application/octet-stream';
            }
          }
        } catch { /* origin will report unavailable below */ }
      }
    }
    if (!bytes && !filePath) {
      await relayJson(`/treasury/assets/${encodeURIComponent(requestId)}/unavailable`, target, {
        method: 'POST', body: JSON.stringify({ device_id: deviceId }),
      });
      continue;
    }
    const stream = filePath ? createReadStream(filePath) : null;
    const uploadInit: RequestInit & { duplex?: 'half' } = {
      method: 'PUT', body: stream ? stream as unknown as RequestInit['body'] : bytes,
      headers: {
        authorization: `Bearer ${target.key}`, 'x-treasury-device-id': deviceId,
        'x-treasury-digest': digest, 'x-treasury-byte-count': String(byteCount),
        'content-type': mimeType,
      },
      signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
    };
    if (stream) uploadInit.duplex = 'half';
    try {
      const uploaded = await fetch(
        `${target.base}/treasury/assets/${encodeURIComponent(requestId)}`, uploadInit,
      );
      await uploaded.body?.cancel().catch(() => undefined);
      if (!uploaded.ok) throw new Error(`relay ${uploaded.status}`);
    } finally {
      stream?.destroy();
    }
  }
}

/** Phase 4 cursor sync. Cached metadata remains available when the relay is offline. */
router.get('/leophone/collections', async (req, res) => {
  const target = relayTarget();
  if (!target) {
    res.json({ configured: false, items: [] });
    return;
  }
  const scope = treasuryScope(target);
  const localDevice = treasuryDeviceId();
  try {
    const userId = authenticatedUserId(req);
    await uploadLocalTreasury(userId, target, scope);
    await pullRemoteTreasury(target, scope);
    await serveLocalTreasuryAssetRequests(userId, target);
    const state = treasuryDb.remoteSyncState(scope);
    res.json({
      configured: true,
      items: treasuryDb.remoteItems(scope).filter((item) => item.origin_device_id !== localDevice),
      updatedAt: state.lastSuccessAt ?? 0,
      cursor: state.cursor,
      stale: false,
    });
  } catch (error) {
    const state = treasuryDb.remoteSyncState(scope);
    const cached = treasuryDb.remoteItems(scope).filter((item) => item.origin_device_id !== localDevice);
    res.status(cached.length ? 200 : 502).json({
      configured: true,
      items: cached,
      updatedAt: state.lastSuccessAt ?? 0,
      cursor: state.cursor,
      stale: true,
      error: { message: publicTreasuryError(error, '手机同步暂时不可用') },
    });
  }
});

type RemoteAssetRequest = {
  id: string; item_id: string; asset_kind: 'body' | 'attachment'; status: string;
};

function remoteAssetDirectory(): string {
  return path.join(path.dirname(getDatabasePath()), 'treasury-assets');
}

async function ensureRemoteAssetDirectory(): Promise<string> {
  const directory = remoteAssetDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('remote treasury cache directory is unsafe');
  }
  await fs.chmod(directory, 0o700);
  return directory;
}

export function cachedAttachmentPath(scope: string, itemId: string, digest: string): string {
  const name = createHash('sha256').update(`${scope}\0${itemId}\0${digest}`).digest('hex');
  return path.join(remoteAssetDirectory(), `${name}.bin`);
}

export function cachedAttachmentPartialPath(scope: string, itemId: string): string {
  const name = createHash('sha256').update(`${scope}\0${itemId}`).digest('hex');
  return path.join(remoteAssetDirectory(), `.${name}.partial`);
}

export function isCachedAttachmentPath(value: string): boolean {
  const root = path.resolve(remoteAssetDirectory()) + path.sep;
  return path.resolve(value).startsWith(root);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function safeAssetHeaders(response: Response, limit: number): {
  digest: string; byteCount: number; mimeType: string;
} {
  const digest = (response.headers.get('x-treasury-digest') ?? '').toLowerCase();
  const byteCount = Number(response.headers.get('x-treasury-byte-count'));
  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(byteCount) ||
      byteCount < 0 || byteCount > limit || !mimeType || /[\r\n]/.test(mimeType) ||
      !isAllowedTreasuryAssetMime(mimeType)) {
    throw new Error('relay returned invalid treasury asset metadata');
  }
  return { digest, byteCount, mimeType };
}

export function isAllowedTreasuryAssetMime(mimeType: string): boolean {
  return ALLOWED_TREASURY_ASSET_MIMES.has(mimeType);
}

export function validTreasuryContentRange(
  value: string | null,
  expectedStart: number,
  expectedTotal: number,
): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) &&
    start === expectedStart && total === expectedTotal && end >= start && end < total;
}

export async function resumableTreasuryPartialSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 ||
        stat.size >= REMOTE_ATTACHMENT_LIMIT) {
      await fs.rm(filePath, { force: true });
      return 0;
    }
    return stat.size;
  } catch {
    return 0;
  }
}

export function isValidCachedBody(asset: {
  content_text: string | null; digest: string; byte_count: number; mime_type: string;
} | null): asset is {
  content_text: string; digest: string; byte_count: number; mime_type: string;
} {
  if (!asset || asset.content_text === null || asset.mime_type !== 'text/plain') return false;
  const bytes = Buffer.from(asset.content_text, 'utf8');
  return bytes.length === asset.byte_count &&
    createHash('sha256').update(bytes).digest('hex') === asset.digest;
}

async function isValidCachedAttachment(
  asset: ReturnType<typeof treasuryDb.remoteAsset>,
  item: RemoteTreasureMetadata,
): Promise<boolean> {
  if (!asset?.file_path || !isCachedAttachmentPath(asset.file_path) ||
      (item.byte_count > 0 && item.byte_count !== asset.byte_count) ||
      (item.content_digest && item.content_digest !== asset.digest) ||
      (item.mime_type && item.mime_type.split(';', 1)[0].toLowerCase() !== asset.mime_type)) return false;
  try {
    const stat = await fs.lstat(asset.file_path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.byte_count &&
      await sha256File(asset.file_path) === asset.digest;
  } catch {
    return false;
  }
}

type RemoteAssetFetchState = { status: 'ready' | 'pending' | 'unavailable'; stale: boolean };
const remoteAssetFetches = new Map<string, Promise<RemoteAssetFetchState>>();

async function requestRemoteAsset(
  target: RelayTarget,
  scope: string,
  item: RemoteTreasureMetadata,
  assetKind: 'body' | 'attachment',
): Promise<RemoteAssetFetchState> {
  const key = `${scope}\0${item.id}\0${assetKind}`;
  const existing = remoteAssetFetches.get(key);
  if (existing) return existing;
  const pending = downloadRemoteAsset(target, scope, item, assetKind);
  remoteAssetFetches.set(key, pending);
  try {
    return await pending;
  } finally {
    if (remoteAssetFetches.get(key) === pending) remoteAssetFetches.delete(key);
  }
}

async function downloadRemoteAsset(
  target: RelayTarget,
  scope: string,
  item: RemoteTreasureMetadata,
  assetKind: 'body' | 'attachment',
): Promise<RemoteAssetFetchState> {
  const requester = treasuryDeviceId();
  const created = await relayJson('/treasury/assets/requests', target, {
    method: 'POST',
    body: JSON.stringify({ item_id: item.id, asset_kind: assetKind, requester_device_id: requester }),
  }) as { request?: RemoteAssetRequest };
  const request = created.request;
  if (!request?.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id) ||
      request.item_id !== item.id || request.asset_kind !== assetKind) {
    throw new Error('relay returned invalid treasury asset request');
  }
  if (request.status === 'pending') return { status: 'pending', stale: false };
  if (request.status !== 'ready') return { status: 'unavailable', stale: false };
  const partialPath = assetKind === 'attachment'
    ? cachedAttachmentPartialPath(scope, item.id)
    : null;
  if (partialPath) await ensureRemoteAssetDirectory();
  let rangeOffset = partialPath ? await resumableTreasuryPartialSize(partialPath) : 0;
  if (rangeOffset > 0 && item.byte_count > 0 && rangeOffset >= item.byte_count) {
    await fs.rm(partialPath!, { force: true });
    rangeOffset = 0;
  }
  let response = await relayRaw(
    `/treasury/assets/${encodeURIComponent(request.id)}`, target, requester, rangeOffset,
  );
  if (response.status === 416 && rangeOffset > 0 && partialPath) {
    await response.body?.cancel().catch(() => undefined);
    await fs.rm(partialPath, { force: true });
    rangeOffset = 0;
    response = await relayRaw(`/treasury/assets/${encodeURIComponent(request.id)}`, target, requester);
  }
  if (response.status === 202) return { status: 'pending', stale: false };
  if (response.status === 410) return { status: 'unavailable', stale: false };
  if (!response.ok) throw new Error(`relay ${response.status}`);
  const limit = assetKind === 'body' ? REMOTE_BODY_LIMIT : REMOTE_ATTACHMENT_LIMIT;
  const metadata = safeAssetHeaders(response, limit);
  if (assetKind === 'attachment') {
    if ((item.byte_count > 0 && item.byte_count !== metadata.byteCount) ||
        (item.content_digest && item.content_digest !== metadata.digest) ||
        (item.mime_type && item.mime_type.split(';', 1)[0].toLowerCase() !== metadata.mimeType)) {
      if (partialPath) await fs.rm(partialPath, { force: true });
      throw new Error('remote treasury attachment does not match metadata');
    }
  } else if (metadata.mimeType !== 'text/plain') {
    throw new Error('remote treasury body has invalid mime type');
  }
  if (assetKind === 'body') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== metadata.byteCount ||
        createHash('sha256').update(bytes).digest('hex') !== metadata.digest) {
      throw new Error('remote treasury asset integrity mismatch');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    treasuryDb.putRemoteAsset({
      scope, item_id: item.id, asset_kind: 'body', content_text: text, file_path: null,
      digest: metadata.digest, byte_count: metadata.byteCount, mime_type: metadata.mimeType,
      updated_at: Date.now() / 1_000,
    });
  } else {
    await ensureRemoteAssetDirectory();
    const targetPath = cachedAttachmentPath(scope, item.id, metadata.digest);
    const temporary = partialPath!;
    if (rangeOffset > 0) {
      if (response.status === 206) {
        if (!validTreasuryContentRange(
          response.headers.get('content-range'), rangeOffset, metadata.byteCount,
        )) {
          await response.body?.cancel().catch(() => undefined);
          await fs.rm(temporary, { force: true });
          throw new Error('remote treasury attachment returned invalid range');
        }
      } else if (response.status === 200) {
        // Older relay/proxy ignored Range. Restart safely instead of appending
        // a full response to the retained prefix.
        await fs.rm(temporary, { force: true });
        rangeOffset = 0;
      } else {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`relay ${response.status}`);
      }
    } else if (response.status === 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('remote treasury attachment returned unsolicited range');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('relay returned an empty treasury attachment');
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(temporary, flags, 0o600);
    const hash = createHash('sha256');
    let byteCount = rangeOffset;
    if (rangeOffset > 0) {
      for await (const chunk of createReadStream(temporary, { start: 0, end: rangeOffset - 1 })) {
        hash.update(chunk as Buffer);
      }
    }
    let discardPartial = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        byteCount += chunk.length;
        if (byteCount > metadata.byteCount || byteCount > REMOTE_ATTACHMENT_LIMIT) {
          discardPartial = true;
          throw new Error('remote treasury attachment exceeds declared size');
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      if (byteCount !== metadata.byteCount || hash.digest('hex') !== metadata.digest) {
        discardPartial = true;
        throw new Error('remote treasury asset integrity mismatch');
      }
      await handle.close();
      await fs.rename(temporary, targetPath);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await handle.close().catch(() => undefined);
      if (discardPartial) await fs.rm(temporary, { force: true });
      throw error;
    }
    const previous = treasuryDb.remoteAsset(scope, item.id, 'attachment');
    treasuryDb.putRemoteAsset({
      scope, item_id: item.id, asset_kind: 'attachment', content_text: null,
      file_path: targetPath, digest: metadata.digest, byte_count: metadata.byteCount,
      mime_type: metadata.mimeType, updated_at: Date.now() / 1_000,
    });
    if (previous?.file_path && previous.file_path !== targetPath && isCachedAttachmentPath(previous.file_path)) {
      await fs.rm(previous.file_path, { force: true });
    }
  }
  return { status: 'ready', stale: false };
}

function remoteItem(scope: string, itemId: string): RemoteTreasureMetadata | null {
  const localDevice = treasuryDeviceId();
  return treasuryDb.remoteItems(scope).find((item) =>
    item.id === itemId && item.origin_device_id !== localDevice && !item.deleted_at) ?? null;
}

export function offlineCollectionCandidates(
  items: RemoteTreasureMetadata[], collectionId: string, limit = 200,
): RemoteTreasureMetadata[] {
  return offlineBodyCandidates(items, collectionId, limit);
}

export function offlineBodyCandidates(
  items: RemoteTreasureMetadata[], collectionId: string | null, limit = 200,
): RemoteTreasureMetadata[] {
  const bounded = Math.max(1, Math.min(limit, 500));
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.deleted_at || !item.body_available ||
        (collectionId !== null && !item.collection_ids.includes(collectionId)) ||
        seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, bounded);
}

router.post('/leophone/collections/offline', async (req, res) => {
  const target = relayTarget();
  if (!target) { res.status(409).json({ error: { message: '未配置中继' } }); return; }
  const collectionId = remoteText(req.body?.collection_id, 200);
  const allBody = req.body?.all_body === true;
  if (!collectionId && !allBody) { res.status(400).json({ error: { message: '合集不能为空' } }); return; }
  const scope = treasuryScope(target);
  const localDevice = treasuryDeviceId();
  const allCandidates = treasuryDb.remoteItems(scope).filter((item) =>
    item.origin_device_id !== localDevice && !item.deleted_at && item.body_available &&
    (allBody || item.collection_ids.includes(collectionId!)));
  const candidates = offlineBodyCandidates(allCandidates, allBody ? null : collectionId);
  const counts = { ready: 0, pending: 0, unavailable: 0, failed: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      const cached = treasuryDb.remoteAsset(scope, item.id, 'body');
      if (isValidCachedBody(cached)) { counts.ready += 1; continue; }
      try {
        const state = await requestRemoteAsset(target, scope, item, 'body');
        const current = treasuryDb.remoteAsset(scope, item.id, 'body');
        if (state.status === 'ready' && isValidCachedBody(current)) counts.ready += 1;
        else if (state.status === 'pending') counts.pending += 1;
        else counts.unavailable += 1;
      } catch { counts.failed += 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  res.json({
    collection_id: collectionId ?? null,
    all_body: allBody,
    total: allCandidates.length,
    attempted: candidates.length,
    truncated: allCandidates.length > candidates.length,
    ...counts,
  });
});

router.get('/leophone/collections/:itemId/body', async (req, res) => {
  const target = relayTarget();
  if (!target) { res.status(409).json({ error: { message: '未配置中继' } }); return; }
  const scope = treasuryScope(target);
  const item = remoteItem(scope, req.params.itemId);
  if (!item || !item.body_available) { res.status(404).json({ error: { message: '远端正文不可用' } }); return; }
  const cached = treasuryDb.remoteAsset(scope, item.id, 'body');
  try {
    const state = await requestRemoteAsset(target, scope, item, 'body');
    const current = treasuryDb.remoteAsset(scope, item.id, 'body') ?? cached;
    if (state.status === 'ready' && isValidCachedBody(current)) {
      res.json({ item, body: current.content_text, status: 'ready', stale: false,
        digest: current.digest, byte_count: current.byte_count });
      return;
    }
    if (isValidCachedBody(current)) {
      res.json({ item, body: current.content_text, status: state.status, stale: true,
        digest: current.digest, byte_count: current.byte_count });
      return;
    }
    res.status(state.status === 'pending' ? 202 : 410).json({ item, body: null, status: state.status });
  } catch (error) {
    if (isValidCachedBody(cached)) {
      res.json({ item, body: cached.content_text, status: 'ready', stale: true,
        digest: cached.digest, byte_count: cached.byte_count });
      return;
    }
    res.status(502).json({ error: { message: publicTreasuryError(error, '远端正文读取失败') } });
  }
});

router.get('/leophone/collections/:itemId/attachment', async (req, res) => {
  const target = relayTarget();
  if (!target) { res.status(409).json({ error: { message: '未配置中继' } }); return; }
  const scope = treasuryScope(target);
  const item = remoteItem(scope, req.params.itemId);
  if (!item || !item.attachment_available) {
    res.status(404).json({ error: { message: '远端附件不可用' } }); return;
  }
  let cached = treasuryDb.remoteAsset(scope, item.id, 'attachment');
  if (!await isValidCachedAttachment(cached, item)) cached = null;
  try {
    if (!cached) {
      const state = await requestRemoteAsset(target, scope, item, 'attachment');
      cached = treasuryDb.remoteAsset(scope, item.id, 'attachment');
      if (state.status !== 'ready' && !await isValidCachedAttachment(cached, item)) {
        res.status(state.status === 'pending' ? 202 : 410).json({ status: state.status }); return;
      }
    }
  } catch (error) {
    if (!cached?.file_path) {
      res.status(502).json({ error: { message: publicTreasuryError(error, '远端附件读取失败') } });
      return;
    }
  }
  if (!await isValidCachedAttachment(cached, item) || !cached?.file_path) {
    res.status(410).json({ error: { message: '远端附件缓存不可用' } }); return;
  }
  if (req.query.status === '1') {
    res.json({ status: 'ready', digest: cached.digest, byte_count: cached.byte_count });
    return;
  }
  res.setHeader('Content-Type', cached.mime_type);
  res.setHeader('X-Treasury-Digest', cached.digest);
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(cached.file_path);
});

export default router;
