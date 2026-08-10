import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';

import { requireHarnessKey } from './harness-auth.js';
import { HarnessRequestError, getHarnessManager } from './harness-session.service.js';
import { availableHarnesses } from './harness-specs.js';
import { fetchGrokToken } from './grok-token.service.js';
import { buildDigest, buildReceipt, isTerminal } from './harness-digest.service.js';
import { listArtifacts, readArtifact } from './harness-artifacts.service.js';

// LeoPhoneAgent harness 协议的 HTTP/SSE 面——与 leoagent(Python server.py)
// 的路由表逐条同构,手机端(LeoAgentClient/LeoAgentHarness.swift)零改动。
// 挂载两处:/leophone 前缀(tailscale serve / 反代直连)与根路径别名
// (中继路径原样透传 /harness/*、/v1/*)。

const VERSION = '0.4.0';

const APP_VERSION = (() => {
  try {
    const appRoot = findAppRoot(getModuleDir(import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version?: string };
    return parsed.version || null;
  } catch {
    return null;
  }
})();

function jsonError(res: express.Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

const router: express.Router = express.Router();

// 免鉴权:可达性探测要能区分"主机不可达"与"钥匙不对"。
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', platform: 'leoagent', version: VERSION, server: 'leocodebox', app_version: APP_VERSION });
});

router.get('/v1/capabilities', requireHarnessKey, (_req, res) => {
  res.json({
    object: 'leoagent.capabilities',
    platform: 'leoagent',
    version: VERSION,
    server: 'leocodebox',
    features: {
      harness_sessions: true,
      // 差异化能力,明说,客户端可以依赖。
      resumable_events: true,
      approval_events: true,
      session_steering: true,
      // [T-leophone-digest] 0.4.0 新增:摘要 / 收据 / 产物
      session_digest: true,
      task_receipts: true,
      artifacts: true,
    },
    harnesses: availableHarnesses(),
  });
});

router.get('/v1/grok/token', requireHarnessKey, async (_req, res) => {
  const result = await fetchGrokToken();
  res.status(result.status).json(result.body);
});

router.get('/harness/sessions', requireHarnessKey, (_req, res) => {
  res.json({ sessions: getHarnessManager().list() });
});

router.post('/harness/sessions', requireHarnessKey, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const harness = String(body.harness ?? '');
  const cwd = String(body.cwd ?? '') || '~';
  const prompt = body.prompt == null ? null : String(body.prompt);
  try {
    const session = await getHarnessManager().create({ harness, cwd, prompt });
    res.status(202).json({ session_id: session.sessionId, harness, status: session.status });
  } catch (error) {
    if (error instanceof HarnessRequestError) {
      jsonError(res, 400, error.message);
      return;
    }
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

router.get('/harness/sessions/:sessionId/events', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const parsed = Number.parseInt(String(req.query.after ?? '0'), 10);
  const after = Number.isNaN(parsed) ? 0 : parsed;

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 会缓冲的代理会毁掉整个断线续传语义。
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });
  // SSE 注释帧保活:iOS 与中继都只认 `data:` 前缀,注释帧被安全跳过。
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 25_000);

  try {
    for await (const event of session.subscribe(after)) {
      if (closed) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch {
    // 客户端走了是常态;会话继续跑,日志继续长,按 seq 续传即可。
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

router.post('/harness/sessions/:sessionId/send', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const text = String(((req.body ?? {}) as Record<string, unknown>).text ?? '');
  if (!text) {
    jsonError(res, 400, 'text is required');
    return;
  }
  try {
    await session.send(text);
  } catch (error) {
    // 死进程、关闭的 stdin、召回的会话——客户端需要真实答案,
    // 不是一个 500 加一条被静默吞掉的消息。
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
    return;
  }
  res.json({ ok: true, seq: session.seq });
});

router.post('/harness/sessions/:sessionId/approval', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const choice = String(body.choice ?? '').toLowerCase();
  const approvalId = body.approval_id == null ? null : String(body.approval_id);

  let pending: Record<string, unknown> | undefined;
  if (approvalId) {
    pending = session.pendingApprovals.get(approvalId);
  } else if (session.pendingApprovals.size === 1) {
    pending = [...session.pendingApprovals.values()][0];
  }
  if (!pending) {
    jsonError(res, 409, 'No such pending approval');
    return;
  }
  const allowed = Array.isArray(pending.choices) && pending.choices.length > 0
    ? pending.choices.map(String)
    : ['once', 'deny'];
  if (!allowed.includes(choice)) {
    jsonError(res, 400, `Invalid choice; expected one of: ${allowed.join(', ')}`);
    return;
  }
  const delivered = await session.respondToApproval(choice, approvalId);
  if (!delivered) {
    // CLI 还在等的时候,客户端的卡片绝不能清掉。
    jsonError(res, 502, 'Approval could not be delivered to the CLI');
    return;
  }
  res.json({ ok: true, choice, approval_id: approvalId });
});

router.post('/harness/sessions/:sessionId/stop', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  await session.stop();
  res.json({ ok: true, status: session.status });
});

// [T-leophone-digest] 会话摘要:接管一个长会话时先拉它,再从 seq 水位
// 增量跟随,不必从 0 全量回放上千条 NDJSON。
router.get('/harness/sessions/:sessionId/digest', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  res.json({ object: 'leoagent.digest', ...buildDigest(session) });
});

// [T-leophone-digest] 任务收据:终态会话的可核对凭证(做了什么、动了哪些
// 文件、谁批了什么、产物)。非终态会话明确 409,不出半截收据。
router.get('/harness/sessions/:sessionId/receipt', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  if (!isTerminal(session.status)) {
    jsonError(res, 409, `Session is still ${session.status}; receipt is issued at terminal state only`);
    return;
  }
  res.json(buildReceipt(session));
});

// [T-leophone-artifacts] 会话产物清单 + 下载。大文件不进事件流、不进推送。
router.get('/harness/sessions/:sessionId/artifacts', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  res.json({ object: 'leoagent.artifacts', session_id: req.params.sessionId, artifacts: listArtifacts(session) });
});

router.get('/harness/sessions/:sessionId/artifacts/:name', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const file = readArtifact(session, req.params.name);
  if (!file) {
    jsonError(res, 404, 'No such artifact');
    return;
  }
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  fs.createReadStream(file.path).pipe(res);
});

export default router;
