import express from 'express';

import { resolveRelayConfig } from './relay-client.service.js';

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
  activeCount: number;
  sessions: Array<Record<string, unknown>>;
};

/** 舰队总览:每台机器 + 它上面的会话与待审批。 */
router.get('/leophone/fleet', async (_req, res) => {
  const target = relayTarget();
  if (!target) {
    res.json({ configured: false, machines: [] });
    return;
  }
  try {
    const payload = (await relayFetch('/machines', target)) as {
      machines?: Array<{ name?: string; online?: boolean }>;
    };
    const machines = payload.machines ?? [];
    const rows: MachineRow[] = await Promise.all(
      machines.map(async (machine) => {
        const name = String(machine.name ?? '');
        const base: MachineRow = {
          name,
          online: machine.online === true,
          reachable: false,
          activeCount: 0,
          sessions: [],
        };
        if (!base.online) return base;
        try {
          const detail = (await relayFetch(
            `/m/${encodeURIComponent(name)}/harness/sessions`,
            target,
          )) as { sessions?: Array<Record<string, unknown>> };
          const sessions = detail.sessions ?? [];
          const active = sessions.filter((s) =>
            ['starting', 'running', 'idle', 'waiting_for_approval'].includes(String(s.status)),
          );
          // reachable 与 online 是两件事:注册着但服务没响应也算不可达,
          // 不能把它显示成"空闲"。
          return { ...base, reachable: true, activeCount: active.length, sessions: active };
        } catch {
          return base;
        }
      }),
    );
    res.json({ configured: true, machines: rows });
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
    const payload = (await relayFetch('/machines', target)) as {
      machines?: Array<{ name?: string; online?: boolean }>;
    };
    const approvals: Array<Record<string, unknown>> = [];
    await Promise.all(
      (payload.machines ?? [])
        .filter((m) => m.online === true)
        .map(async (machine) => {
          const name = String(machine.name ?? '');
          try {
            const detail = (await relayFetch(
              `/m/${encodeURIComponent(name)}/harness/sessions`,
              target,
            )) as { sessions?: Array<Record<string, unknown>> };
            for (const session of detail.sessions ?? []) {
              const pending = (session.pending_approvals as Array<Record<string, unknown>>) ?? [];
              for (const approval of pending) {
                approvals.push({
                  machine: name,
                  session_id: session.session_id,
                  harness: session.harness,
                  seq: session.seq ?? 0,
                  approval_id: approval.approval_id,
                  command: approval.command ?? '',
                  choices: approval.choices ?? ['once', 'deny'],
                });
              }
            }
          } catch {
            // 单台不可达不影响其余
          }
        }),
    );
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
  if (!machine || !sessionId || !approvalId || !choice) {
    res.status(400).json({ error: { message: 'machine/session_id/approval_id/choice required' } });
    return;
  }
  try {
    const result = await relayPost(
      `/m/${encodeURIComponent(String(machine))}/harness/sessions/${encodeURIComponent(String(sessionId))}/approval`,
      target,
      { approval_id: approvalId, choice },
    );
    res.json({ ok: true, result });
  } catch (error) {
    // 送不到就明说,不能让 UI 把卡片清掉而 CLI 还在等
    res.status(502).json({
      error: { message: error instanceof Error ? error.message : 'approval not delivered' },
    });
  }
});

export default router;
