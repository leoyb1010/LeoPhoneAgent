import express from 'express';

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
const SNAPSHOT_CACHE_MS = 3_000;

type RelayTarget = { base: string; key: string };

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

/** [T-collections-fleet] 手机上传的收藏索引(只读镜像)。 */
router.get('/leophone/collections', async (_req, res) => {
  const target = relayTarget();
  if (!target) {
    res.json({ configured: false, items: [] });
    return;
  }
  try {
    const payload = (await relayFetch('/collections', target)) as {
      items?: unknown[];
      updated_at?: number;
    };
    res.json({
      configured: true,
      items: payload.items ?? [],
      updatedAt: payload.updated_at ?? 0,
    });
  } catch (error) {
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'relay unreachable' },
    });
  }
});

export default router;
