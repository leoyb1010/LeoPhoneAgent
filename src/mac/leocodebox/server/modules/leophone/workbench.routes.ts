import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';

import express from 'express';
import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { bindFrontmostToSession, bindSessionWindow, clickBoundSessionWindow, dragBoundSessionWindow, exactWindows, keyBoundSessionWindow, listBindableSessionWindows, listBoundSessionMenus, menuBoundSessionWindow, peekBoundSessionWindow, raiseBoundSessionWindow, readBoundSessionWindow, scrollBoundSessionWindow, typeBoundSessionWindow } from '../leocodebox/index.js';

import { HarnessRequestError, getHarnessManager, type HarnessSession } from './harness-session.service.js';
import { copyDroppedFile, writeDroppedBytes } from './local-drop.js';
import { openLocalPath, openLocalTerminal, pickLocalFolder, revealLocalPath } from './local-folder.js';
import { commitSessionFiles } from './session-commit.js';
import { diffSessionFile } from './session-diff.js';
import { writeSessionExport } from './session-export.js';
import { revertSessionFile } from './session-revert.js';
import { searchSessionCwd } from './session-search.js';
import { ensureSessionWorkspace } from './session-workspace.js';
import { availableHarnesses } from './harness-specs.js';
import { PI_AUTH_PATH, PI_MODELS_PATH, authStatus, clearAuth, ensureDirs, setApiKey } from './pi-runtime.js';
import { ModelsJsonError, listCustomProviderIds, removeCustomProvider, upsertCustomModel, upsertCustomProvider } from './pi-models.js';
import { describeProvider, refreshOAuthCatalogs, sketchProviderAuth } from './pi-provider-catalog.js';
import { resumeEnvelope } from './resume-envelope.js';
import { telegramChannel } from './telegram.service.js';
import { listArtifacts, readArtifactText } from './harness-artifacts.service.js';

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

router.post('/leophone/local/folder/pick', async (_req, res) => {
  try {
    res.json(await pickLocalFolder());
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/folder/reveal', async (req, res) => {
  const target = String(((req.body ?? {}) as Record<string, unknown>).path ?? '').trim();
  if (!target) {
    jsonError(res, 400, '路径不能为空');
    return;
  }
  try {
    const row = await revealLocalPath(target);
    res.json({ ok: true, path: row.path });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/folder/open', async (req, res) => {
  const target = String(((req.body ?? {}) as Record<string, unknown>).path ?? '').trim();
  if (!target) {
    jsonError(res, 400, '路径不能为空');
    return;
  }
  try {
    const row = await openLocalPath(target);
    res.json({ ok: true, path: row.path });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/folder/term', async (req, res) => {
  const target = String(((req.body ?? {}) as Record<string, unknown>).path ?? '').trim();
  if (!target) {
    jsonError(res, 400, '路径不能为空');
    return;
  }
  try {
    const row = await openLocalTerminal(target);
    res.json({ ok: true, path: row.path });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/drop', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cwd = String(body.cwd ?? '').trim();
  if (!cwd) {
    jsonError(res, 400, '没有会话目录');
    return;
  }
  try {
    const fromPath = String(body.fromPath ?? '').trim();
    const row = fromPath
      ? await copyDroppedFile(cwd, fromPath)
      : await writeDroppedBytes(cwd, String(body.name ?? 'dropped.bin'), Buffer.from(String(body.content ?? ''), 'base64'));
    res.json(row);
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/workspace', async (req, res) => {
  const cwd = String(((req.body ?? {}) as Record<string, unknown>).cwd ?? '').trim();
  if (!cwd) {
    jsonError(res, 400, '目录不能为空');
    return;
  }
  try {
    res.json(await ensureSessionWorkspace(cwd));
  } catch (error) {
    jsonError(res, 400, error instanceof Error ? error.message : String(error));
  }
});

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
    void bindFrontmostToSession(session.sessionId, { timeoutMs: 750 }).then((snapshot) => {
      if (snapshot) session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
    }).catch(() => {
      // 没有辅助进程 / TCC / 前台窗口时,会话照常能用。
    });
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

router.get('/leophone/local/sessions/:sessionId/artifacts', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json({ object: 'leoagent.artifacts', session_id: session.sessionId, artifacts: await listArtifacts(session) });
});

router.get('/leophone/local/sessions/:sessionId/artifacts/:name/text', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
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

router.get('/leophone/local/sessions/:sessionId/windows', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const windows = await listBindableSessionWindows({ timeoutMs: 1500 });
    res.json({ ok: true, windows });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/window/bind', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await bindSessionWindow(session.sessionId, body.snapshotId, { timeoutMs: 1500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title });
});

router.get('/leophone/local/sessions/:sessionId/window/peek', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const result = await peekBoundSessionWindow(session.sessionId, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, image: result.image });
});

router.post('/leophone/local/sessions/:sessionId/window/raise', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const result = await raiseBoundSessionWindow(session.sessionId, { timeoutMs: 1500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title });
});

router.post('/leophone/local/sessions/:sessionId/window/click', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await clickBoundSessionWindow(session.sessionId, body.x, body.y, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, x: result.x, y: result.y });
});

router.post('/leophone/local/sessions/:sessionId/window/type', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await typeBoundSessionWindow(session.sessionId, body.text, body.elementId, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, elementId: result.elementId });
});

router.post('/leophone/local/sessions/:sessionId/window/read', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await readBoundSessionWindow(session.sessionId, body.elementId, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, elementId: result.elementId, text: result.text });
});

router.post('/leophone/local/sessions/:sessionId/window/key', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await keyBoundSessionWindow(session.sessionId, body.key, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, key: result.key });
});

router.post('/leophone/local/sessions/:sessionId/window/scroll', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await scrollBoundSessionWindow(session.sessionId, body.x, body.y, body.dx, body.dy, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, x: result.x, y: result.y, dx: result.dx, dy: result.dy });
});

router.post('/leophone/local/sessions/:sessionId/window/drag', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await dragBoundSessionWindow(session.sessionId, body.x, body.y, body.x2, body.y2, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, x: result.x, y: result.y, x2: result.x2, y2: result.y2 });
});

router.get('/leophone/local/sessions/:sessionId/window/menus', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const result = await listBoundSessionMenus(session.sessionId, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, menus: result.menus });
});

router.post('/leophone/local/sessions/:sessionId/window/menu', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await menuBoundSessionWindow(session.sessionId, body.path, { timeoutMs: 2500 });
  if (!result.ok) {
    jsonError(res, result.reason === 'unknown-snapshot' ? 404 : result.reason === 'invalid-request' ? 400 : 409, result.message);
    return;
  }
  session.emit({ event: 'window.bound', ...(exactWindows.summary(session.sessionId) ?? {}) });
  res.json({ ok: true, app: result.app, title: result.title, path: result.path });
});

router.post('/leophone/local/sessions/:sessionId/file/revert', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const file = String(((req.body ?? {}) as Record<string, unknown>).file ?? '').trim();
  try {
    res.json(await revertSessionFile(session.cwd, file));
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/search', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const query = String(((req.body ?? {}) as Record<string, unknown>).query ?? '');
  try {
    res.json(await searchSessionCwd(session.cwd, query));
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/file/diff', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const file = String(((req.body ?? {}) as Record<string, unknown>).file ?? '').trim();
  try {
    res.json(await diffSessionFile(session.cwd, file));
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/export', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    res.json(await writeSessionExport(session.cwd, {
      name: String(body.name ?? 'leo-对话.md'),
      markdown: String(body.markdown ?? ''),
    }));
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/file/commit', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const files = Array.isArray(body.files) ? body.files.map((file) => String(file ?? '')) : [];
  try {
    res.json(await commitSessionFiles(session.cwd, { message: String(body.message ?? ''), files }));
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

router.post('/leophone/local/sessions/:sessionId/continue', async (req, res) => {
  try {
    const session = await getHarnessManager().continue(req.params.sessionId);
    res.json({ ok: true, session_id: session.sessionId, session: session.summary() });
  } catch (error) {
    if (error instanceof HarnessRequestError) {
      jsonError(res, error.message === 'No such session' ? 404 : 409, error.message);
      return;
    }
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/forget', async (req, res) => {
  try {
    await getHarnessManager().forget(req.params.sessionId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof HarnessRequestError) {
      jsonError(res, error.message === 'No such session' ? 404 : 409, error.message);
      return;
    }
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
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

router.post('/leophone/local/sessions/:sessionId/title', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const title = session.setTitle(String(((req.body ?? {}) as Record<string, unknown>).title ?? ''));
    res.json({ ok: true, title });
  } catch (error) {
    jsonError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

router.post('/leophone/local/sessions/:sessionId/policy', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const policy = session.setPolicy(((req.body ?? {}) as Record<string, unknown>).policy);
  res.json({ ok: true, policy });
});

/** pi 原生命令(白名单):换模型 / 压缩 / 中止 / 插话 / 排队 / 取消排队 / 思考深度。回执经事件流回来。 */
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
    // 创建时不拉网:OAuth 目录在 GET /providers 和登录成功后按提供方刷新。
    runtimePromise = ModelRuntime.create({
      authPath: PI_AUTH_PATH,
      modelsPath: PI_MODELS_PATH,
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

router.get('/leophone/pi/providers', async (_req, res) => {
  try {
    const runtime = await modelRuntime();
    const customIds = new Set(listCustomProviderIds());
    const storedAuth = authStatus();
    const raw = runtime.getProviders().map((p) => p as unknown as { id: string; name?: string; auth?: { oauth?: unknown } });
    const oauthIds = raw
      .map((p) => sketchProviderAuth(runtime, p, customIds, storedAuth))
      .filter((p) => p.oauth && p.configured)
      .map((p) => p.id);
    const signal = AbortSignal.timeout(8_000);
    try {
      await refreshOAuthCatalogs(runtime, oauthIds, signal);
    } catch {
      // 提供方列表仍按运行时当前返回值画,不回落到本地预设表。
    }
    const providers = await Promise.all(raw.map((p) => describeProvider(runtime, p, customIds, storedAuth, { refreshOAuth: false, signal })));
    providers.sort((a, b) => Number(b.configured) - Number(a.configured) || Number(b.oauth) - Number(a.oauth) || a.name.localeCompare(b.name, 'zh'));
    res.json({ providers, auth: storedAuth, custom: [...customIds] });
  } catch (error) {
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

router.put('/leophone/pi/custom-providers', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const models = Array.isArray(body.models)
    ? (body.models as Array<Record<string, unknown>>).map((m) => ({ id: String(m.id ?? ''), name: m.name == null ? undefined : String(m.name) }))
    : (body.modelId ? [{ id: String(body.modelId), name: body.modelName == null ? undefined : String(body.modelName) }] : undefined);
  try {
    const provider = upsertCustomProvider({
      id: String(body.id ?? ''),
      name: body.name == null ? undefined : String(body.name),
      baseUrl: String(body.baseUrl ?? ''),
      api: body.api == null ? undefined : String(body.api),
      models,
    });
    const key = String(body.key ?? '').trim();
    if (key) setApiKey(assertSafeCustomId(String(body.id ?? '')), key);
    resetModelRuntime();
    res.json({ ok: true, provider: { id: String(body.id ?? '').trim().toLowerCase(), ...provider, apiKey: undefined } });
  } catch (error) {
    jsonError(res, error instanceof ModelsJsonError ? 400 : 500, error instanceof Error ? error.message : String(error));
  }
});

router.put('/leophone/pi/custom-providers/:providerId/models', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const provider = upsertCustomModel(req.params.providerId, { id: String(body.id ?? ''), name: body.name == null ? undefined : String(body.name) });
    resetModelRuntime();
    res.json({ ok: true, provider: { id: req.params.providerId, ...provider, apiKey: undefined } });
  } catch (error) {
    jsonError(res, error instanceof ModelsJsonError ? 400 : 500, error instanceof Error ? error.message : String(error));
  }
});

router.delete('/leophone/pi/custom-providers/:providerId', (req, res) => {
  try {
    const removed = removeCustomProvider(req.params.providerId);
    if (removed) {
      clearAuth(req.params.providerId);
      resetModelRuntime();
    }
    res.json({ ok: true, removed });
  } catch (error) {
    jsonError(res, error instanceof ModelsJsonError ? 400 : 500, error instanceof Error ? error.message : String(error));
  }
});

function assertSafeCustomId(id: string): string {
  return String(id ?? '').trim().toLowerCase();
}

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

// -- OAuth 登录(pi-ai 内置流程) ---------------------------------------------
//
// 登录是一场对话:pi-ai 会 notify(auth_url / device_code / progress / info),偶尔
// prompt(要你输个码或选一项)。渲染层轮询 flow 状态,把这些原样画出来;要答什么
// 走 answer。凭据落在我们自己的 auth.json(authPath),登完重建运行时即可生效。

type LoginFlow = {
  id: string;
  provider: string;
  type: 'oauth' | 'api_key';
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  events: Array<Record<string, unknown>>;
  prompt: { id: string; type: string; message: string; placeholder?: string; options?: unknown } | null;
  resolvePrompt: ((value: string) => void) | null;
  error?: string;
  abort: AbortController;
};
const loginFlows = new Map<string, LoginFlow>();

function pruneLoginFlows(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, flow] of loginFlows) if (flow.startedAt < cutoff && flow.status !== 'running') loginFlows.delete(id);
}

router.post('/leophone/pi/providers/:providerId/login', async (req, res) => {
  pruneLoginFlows();
  const providerId = req.params.providerId;
  const type = String(((req.body ?? {}) as Record<string, unknown>).type ?? 'oauth') === 'api_key' ? 'api_key' : 'oauth';
  let runtime: ModelRuntime;
  try { runtime = await modelRuntime(); } catch (error) { jsonError(res, 500, error instanceof Error ? error.message : String(error)); return; }
  const flow: LoginFlow = { id: randomUUID(), provider: providerId, type, status: 'running', startedAt: Date.now(), events: [], prompt: null, resolvePrompt: null, abort: new AbortController() };
  loginFlows.set(flow.id, flow);
  const interaction: AuthInteraction = {
    signal: flow.abort.signal,
    prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
      const p = prompt as unknown as { type: string; message: string; placeholder?: string; options?: unknown };
      flow.prompt = { id: randomUUID(), type: p.type, message: p.message, placeholder: p.placeholder, options: p.options };
      flow.resolvePrompt = (value) => { flow.prompt = null; flow.resolvePrompt = null; resolve(value); };
      flow.abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    notify: (event) => { flow.events.push({ ...(event as unknown as Record<string, unknown>), at: Date.now() }); },
  };
  void runtime.login(providerId, type, interaction)
    .then(async () => {
      try { await refreshOAuthCatalogs(runtime, [providerId]); } catch { /* 登录已成功;目录下次重载再拉 */ }
      flow.status = 'done';
      resetModelRuntime();
    })
    .catch((error) => {
      flow.status = flow.abort.signal.aborted ? 'cancelled' : 'error';
      flow.error = error instanceof Error ? error.message : String(error);
    });
  res.status(202).json({ flow_id: flow.id });
});

router.get('/leophone/pi/login/:flowId', (req, res) => {
  const flow = loginFlows.get(req.params.flowId);
  if (!flow) { jsonError(res, 404, 'No such login flow'); return; }
  res.json({ id: flow.id, provider: flow.provider, type: flow.type, status: flow.status, events: flow.events, prompt: flow.prompt, error: flow.error ?? null });
});

router.post('/leophone/pi/login/:flowId/answer', (req, res) => {
  const flow = loginFlows.get(req.params.flowId);
  if (!flow) { jsonError(res, 404, 'No such login flow'); return; }
  if (!flow.resolvePrompt) { jsonError(res, 409, 'Nothing to answer right now'); return; }
  flow.resolvePrompt(String(((req.body ?? {}) as Record<string, unknown>).value ?? ''));
  res.json({ ok: true });
});

router.post('/leophone/pi/login/:flowId/cancel', (req, res) => {
  const flow = loginFlows.get(req.params.flowId);
  if (!flow) { jsonError(res, 404, 'No such login flow'); return; }
  flow.abort.abort();
  res.json({ ok: true });
});

router.post('/leophone/pi/providers/:providerId/logout', async (req, res) => {
  try {
    const runtime = await modelRuntime();
    await runtime.logout(req.params.providerId);
    clearAuth(req.params.providerId);
    resetModelRuntime();
    res.json({ ok: true, auth: authStatus() });
  } catch (error) {
    jsonError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

// -- 通道:Telegram ---------------------------------------------------------------

router.get('/leophone/channels', (_req, res) => {
  res.json({ telegram: telegramChannel.status() });
});

router.put('/leophone/channels/telegram', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const next = telegramChannel.update({
    enabled: body.enabled as boolean | undefined,
    token: body.token as string | undefined,
    apiBase: body.apiBase as string | undefined,
    defaultCwd: body.defaultCwd as string | undefined,
    model: body.model as string | null | undefined,
    policy: body.policy as string | undefined,
  });
  res.json({ ok: true, telegram: { ...telegramChannel.status(), tokenSet: Boolean(next.token) } });
});

router.post('/leophone/channels/telegram/pairing', (_req, res) => {
  res.json({ ok: true, code: telegramChannel.newPairingCode(), expiresInMs: 10 * 60 * 1000 });
});

router.delete('/leophone/channels/telegram/chats/:chatId', (req, res) => {
  telegramChannel.removeChat(Number(req.params.chatId));
  res.json({ ok: true, telegram: telegramChannel.status() });
});

export default router;
