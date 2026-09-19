import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { HarnessRequestError, getHarnessManager, type HarnessSession } from './harness-session.service.js';
import { availableHarnesses } from './harness-specs.js';
import { PI_AUTH_PATH, PI_HOME, authStatus, clearAuth, ensureDirs, setApiKey } from './pi-runtime.js';
import { resumeEnvelope } from './resume-envelope.js';

// 2.0 工作台的本机 API。挂在 /api 下、走桌面本地鉴权,给渲染层用;
// 手机那条 Bearer harness-key 的路(leophone.routes)原样不动。
//
// 本机会话直接读写 HarnessManager,不经中继;远程机器仍走 fleet.routes 的中继代理。
// 两条路返回同一种事件词汇,渲染层不区分本机与远程 —— 这是"一条流水,任何设备续写"的前提。

const router = express.Router();

function jsonError(res: express.Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

function parseModel(input: unknown): { provider: string; modelId: string } | null {
  if (typeof input === 'string') {
    const slash = input.indexOf('/');
    return slash > 0 ? { provider: input.slice(0, slash).trim(), modelId: input.slice(slash + 1).trim() } : null;
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const provider = String(obj.provider ?? '').trim();
    const modelId = String(obj.modelId ?? obj.model ?? '').trim();
    if (provider && modelId) return { provider, modelId };
  }
  return null;
}

function requireSession(req: express.Request, res: express.Response): HarnessSession | null {
  const session = getHarnessManager().get(req.params.sessionId);
  if (!session) {
    jsonError(res, 404, 'No such session');
    return null;
  }
  return session;
}

// -- 本机总览 -----------------------------------------------------------------

router.get('/leophone/local', async (_req, res) => {
  try {
    const manager = getHarnessManager();
    await manager.ready();
    res.json({
      name: os.hostname(),
      platform: process.platform,
      home: os.homedir(),
      harnesses: availableHarnesses(),
      providers: authStatus(),
      sessions: manager.list(),
    });
  } catch (error) {
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

// -- 本机会话 -----------------------------------------------------------------

router.post('/leophone/local/sessions', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const harness = String(body.harness ?? 'pi');
  const cwd = String(body.cwd ?? '') || '~';
  const prompt = body.prompt == null ? null : String(body.prompt);
  const model = parseModel(body.model);
  const policy = body.policy == null ? undefined : String(body.policy);
  try {
    const session = await getHarnessManager().create({ harness, cwd, prompt, model, policy });
    res.status(202).json({ session_id: session.sessionId, session: session.summary() });
  } catch (error) {
    if (error instanceof HarnessRequestError) {
      jsonError(res, 400, error.message);
      return;
    }
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

router.get('/leophone/local/sessions/:sessionId', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json(session.summary());
});

/** 与手机同一套语义:先按 ?after=N 回放,再实时跟随;注释帧保活。 */
router.get('/leophone/local/sessions/:sessionId/events', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const parsed = Number.parseInt(String(req.query.after ?? '0'), 10);
  const after = Number.isNaN(parsed) ? 0 : parsed;

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  const abort = new AbortController();
  res.on('close', () => { closed = true; abort.abort(); });
  const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 25_000);

  try {
    res.write(`data: ${JSON.stringify(resumeEnvelope(after, 0))}\n\n`);
    for await (const event of session.subscribe(after, { signal: abort.signal })) {
      if (closed) break;
      if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: abort.signal });
    }
  } catch {
    // 客户端走了是常态。
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

router.post('/leophone/local/sessions/:sessionId/send', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const text = String(((req.body ?? {}) as Record<string, unknown>).text ?? '');
  if (!text.trim()) {
    jsonError(res, 400, 'text is required');
    return;
  }
  try {
    await session.send(text);
    res.json({ ok: true, status: session.status });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/stop', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  await session.stop();
  res.json({ ok: true, status: session.status });
});

router.post('/leophone/local/sessions/:sessionId/approval', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const choice = String(body.choice ?? '').toLowerCase();
  const approvalId = body.approval_id == null ? null : String(body.approval_id);
  let pending: Record<string, unknown> | undefined;
  if (approvalId) pending = session.pendingApprovals.get(approvalId);
  else if (session.pendingApprovals.size === 1) pending = [...session.pendingApprovals.values()][0];
  if (!pending) {
    jsonError(res, 409, 'No such pending approval');
    return;
  }
  const allowed = Array.isArray(pending.choices) && pending.choices.length > 0 ? pending.choices.map(String) : ['once', 'deny'];
  if (!allowed.includes(choice)) {
    jsonError(res, 400, `Invalid choice; expected one of: ${allowed.join(', ')}`);
    return;
  }
  const delivered = await session.respondToApproval(choice, approvalId);
  if (!delivered) {
    jsonError(res, 502, 'Approval could not be delivered');
    return;
  }
  res.json({ ok: true, choice, approval_id: approvalId ?? pending.approval_id ?? null });
});

router.post('/leophone/local/sessions/:sessionId/policy', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const policy = session.setPolicy(((req.body ?? {}) as Record<string, unknown>).policy);
  res.json({ ok: true, policy });
});

/** pi 原生命令(白名单):换模型 / 压缩 / 中止 / 插话 / 思考深度。回执经事件流回来。 */
const RPC_ALLOWED = new Set(['set_model', 'compact', 'abort', 'steer', 'follow_up', 'set_thinking_level', 'clear_queue']);
router.post('/leophone/local/sessions/:sessionId/rpc', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const frame = (req.body ?? {}) as Record<string, unknown>;
  const type = String(frame.type ?? '');
  if (!RPC_ALLOWED.has(type)) {
    jsonError(res, 400, `unsupported command: ${type}`);
    return;
  }
  const delivered = session.sendFrame({ id: frame.id ?? `wb_${Date.now()}`, ...frame });
  if (!delivered) {
    jsonError(res, 409, 'session is not a live pi session');
    return;
  }
  res.json({ ok: true });
});

// -- pi 供应商与模型(设置页) ---------------------------------------------------

let runtimePromise: Promise<ModelRuntime> | null = null;
function modelRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    ensureDirs();
    runtimePromise = ModelRuntime.create({
      authPath: PI_AUTH_PATH,
      modelsPath: path.join(PI_HOME, 'models.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  }
  return runtimePromise;
}

/** 凭据文件变了就重建运行时;它自己不监听文件。 */
function resetModelRuntime(): void {
  runtimePromise = null;
}

function describeProvider(runtime: ModelRuntime, provider: { id: string } & Record<string, unknown>) {
  const id = provider.id;
  let status: unknown = null;
  try { status = runtime.getProviderAuthStatus(id); } catch { status = null; }
  // models.json 里写死了 apiKey 的自定义供应商(本地网关、mock)也算配置好了。
  const registered = runtime.getRegisteredProviderConfig(id) as { apiKey?: unknown } | undefined;
  const inlineKey = Boolean(registered?.apiKey);
  return {
    id,
    name: typeof provider.name === 'string' ? provider.name : id,
    oauth: Boolean((provider as { auth?: { oauth?: unknown } }).auth?.oauth),
    // getProviderAuthStatus 是最准的口径(含 models.json 内联密钥);其余两条做兜底。
    configured: Boolean((status as { configured?: boolean } | null)?.configured) || runtime.hasConfiguredAuth(id) || inlineKey,
    usingOAuth: runtime.isUsingOAuth(id),
    usingSubscription: runtime.isUsingSubscription(id),
    status,
    models: runtime.getModels(id).map((m) => ({ id: m.id, name: (m as { name?: string }).name ?? m.id })),
  };
}

router.get('/leophone/pi/providers', async (_req, res) => {
  try {
    const runtime = await modelRuntime();
    const providers = runtime.getProviders().map((p) => describeProvider(runtime, p as unknown as { id: string } & Record<string, unknown>));
    res.json({ providers, auth: authStatus() });
  } catch (error) {
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

router.put('/leophone/pi/providers/:providerId/key', (req, res) => {
  const key = String(((req.body ?? {}) as Record<string, unknown>).key ?? '').trim();
  if (!key) {
    jsonError(res, 400, 'key is required');
    return;
  }
  setApiKey(req.params.providerId, key);
  resetModelRuntime();
  res.json({ ok: true, provider: req.params.providerId, auth: authStatus() });
});

router.delete('/leophone/pi/providers/:providerId/key', (req, res) => {
  clearAuth(req.params.providerId);
  resetModelRuntime();
  res.json({ ok: true, provider: req.params.providerId, auth: authStatus() });
});

export default router;
