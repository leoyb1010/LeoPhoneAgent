import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';
import { bindFrontmostToSession, exactWindowCapabilities, exactWindows } from '../leocodebox/index.js';

import { requireHarnessKey } from './harness-auth.js';
import { HarnessRequestError, getHarnessManager } from './harness-session.service.js';
import { availableHarnesses } from './harness-specs.js';
import { fetchGrokToken } from './grok-token.service.js';
import { buildDigest, buildReceipt, isTerminal } from './harness-digest.service.js';
import { listArtifacts, readArtifact, readArtifactText } from './harness-artifacts.service.js';
import { resumeEnvelope } from './resume-envelope.js';

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

router.get('/v1/capabilities', requireHarnessKey, async (_req, res) => {
  const windows = await exactWindowCapabilities({ timeoutMs: 750 });
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
      exact_window: windows.available,
    },
    window_capabilities: windows,
    harnesses: availableHarnesses(),
  });
});

router.get('/v1/grok/token', requireHarnessKey, async (_req, res) => {
  const result = await fetchGrokToken();
  res.status(result.status).json(result.body);
});

router.use('/harness', requireHarnessKey, async (_req, _res, next) => {
  await getHarnessManager().ready();
  next();
});

router.get('/harness/sessions', requireHarnessKey, (_req, res) => {
  res.json({ sessions: getHarnessManager().list() });
});

/** 接受 "provider/modelId" 字符串或 { provider, modelId | model } 对象;都没有就交给运行时默认。 */
function parseModel(input: unknown): { provider: string; modelId: string } | null {
  if (typeof input === 'string') {
    const slash = input.indexOf('/');
    if (slash > 0) return { provider: input.slice(0, slash).trim(), modelId: input.slice(slash + 1).trim() };
    return null;
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const provider = String(obj.provider ?? '').trim();
    const modelId = String(obj.modelId ?? obj.model ?? '').trim();
    if (provider && modelId) return { provider, modelId };
  }
  return null;
}

router.post('/harness/sessions', requireHarnessKey, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const harness = String(body.harness ?? '');
  const cwd = String(body.cwd ?? '') || '~';
  const prompt = body.prompt == null ? null : String(body.prompt);
  const model = parseModel(body.model);
  const policy = body.policy == null ? undefined : String(body.policy);
  try {
    const session = await getHarnessManager().create({ harness, cwd, prompt, model, policy });
    res.status(202).json({ session_id: session.sessionId, harness, status: session.status, window: session.summary().window });
    // Observation is optional enrichment, never a synchronous 4-second gate on
    // starting an agent. The bounded native process cannot block the event loop.
    void bindFrontmostToSession(session.sessionId, { timeoutMs: 750 }).then((snapshot) => {
      if (snapshot) session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
    }).catch(() => {
      // Missing helper/TCC or a gone window leaves the run fully usable.
    });
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
  const abort = new AbortController();
  res.on('close', () => { closed = true; abort.abort(); });
  // SSE 注释帧保活:iOS 与中继都只认 `data:` 前缀,注释帧被安全跳过。
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 25_000);

  try {
    // Resume acknowledges the requested cursor; journal control frames report
    // missing ranges and persistence failures independently of event sequence.
    res.write(`data: ${JSON.stringify(resumeEnvelope(after, 0))}\n\n`);
    for await (const event of session.subscribe(after, { signal: abort.signal, journalStatus: req.query.journal_status === '1' })) {
      if (closed) break;
      if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: abort.signal });
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

router.post('/harness/sessions/:sessionId/policy', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const policy = session.setPolicy(((req.body ?? {}) as Record<string, unknown>).policy);
  res.json({ ok: true, policy });
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
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const delivered = await session.respondToApproval(choice, approvalId, reason);
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
router.get('/harness/sessions/:sessionId/digest', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  res.json({ object: 'leoagent.digest', ...await buildDigest(session) });
});

// [T-leophone-digest] 任务收据:终态会话的可核对凭证(做了什么、动了哪些
// 文件、谁批了什么、产物)。非终态会话明确 409,不出半截收据。
router.get('/harness/sessions/:sessionId/receipt', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  if (!isTerminal(session.status)) {
    jsonError(res, 409, `Session is still ${session.status}; receipt is issued at terminal state only`);
    return;
  }
  try { res.json(await buildReceipt(session)); }
  catch (error) {
    if (error instanceof Error && error.message === 'JOURNAL_NOT_DURABLE') {
      res.status(503).json({ error: 'JOURNAL_NOT_DURABLE', journal: session.journalHealth() });
      return;
    }
    throw error;
  }
});

// [T-leophone-artifacts] 会话产物清单 + 下载。大文件不进事件流、不进推送。
router.get('/harness/sessions/:sessionId/artifacts', requireHarnessKey, async (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  res.json({ object: 'leoagent.artifacts', session_id: req.params.sessionId, artifacts: await listArtifacts(session) });
});

router.get('/harness/sessions/:sessionId/artifacts/:name/text', requireHarnessKey, (req, res) => {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return;
  }
  const text = readArtifactText(session, req.params.name);
  if (!text) {
    jsonError(res, 404, 'No such artifact');
    return;
  }
  if (!text.ok) {
    jsonError(res, 415, text.error);
    return;
  }
  res.json({ name: text.name, content: text.content, truncated: text.truncated });
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
