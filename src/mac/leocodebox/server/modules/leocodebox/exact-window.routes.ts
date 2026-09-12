import express from 'express';

import { exactWindows, WindowOperationError, type ExactWindowStore } from './exact-window.js';
import { exactWindowCapabilities, macWindowDriver, type createMacWindowDriver } from './exact-window-macos.js';

type WindowDriver = ReturnType<typeof createMacWindowDriver>;
type AsyncHandler = (req: express.Request, res: express.Response, signal: AbortSignal) => Promise<void>;
function statusFor(reason: string): number {
  if (reason === 'invalid-request') return 400;
  if (reason === 'permission-denied') return 403;
  if (reason === 'unknown-snapshot' || reason === 'window-gone') return 404;
  if (reason === 'unsupported-action' || reason === 'unsupported-platform') return 501;
  if (reason === 'helper-unavailable' || reason === 'observation-unavailable') return 503;
  if (reason === 'timeout') return 504;
  return 409;
}
function asyncWindow(handler: AsyncHandler): express.RequestHandler {
  return (req, res) => {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    void handler(req, res, abort.signal).catch((error: unknown) => {
      if (res.destroyed || res.headersSent) return;
      const failure = error instanceof WindowOperationError ? error : new WindowOperationError('observation-unavailable', '无法读取原生窗口。');
      res.status(statusFor(failure.reason)).json({ success: false, error: failure.reason, reason: failure.reason, message: failure.message,
        ...(failure.receipt ? { receipt: failure.receipt } : {}) });
    }).finally(() => { req.removeListener('aborted', disconnect); res.removeListener('close', disconnect); });
  };
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new WindowOperationError('invalid-request', `${label} required`);
  return value.trim();
}

export function createExactWindowRouter(store: ExactWindowStore = exactWindows, driver: WindowDriver = macWindowDriver): express.Router {
  const router = express.Router();
  router.get('/', asyncWindow(async (_req, res, signal) => {
    const windows = (await driver.list({ signal })).map((row) => {
      const snapshot = store.capture(row);
      return { ...row, machine: snapshot.ref.machine, snapshot_id: snapshot.snapshotId };
    });
    res.json({ success: true, windows });
  }));
  router.get('/capabilities', asyncWindow(async (_req, res, signal) => {
    res.json({ success: true, ...(await exactWindowCapabilities({ signal, timeoutMs: 750 }, driver)) });
  }));
  router.post('/bind', asyncWindow(async (req, res, signal) => {
    const sessionId = identifier(req.body?.sessionId, 'sessionId');
    if (typeof req.body?.snapshotId === 'string' && req.body.snapshotId.trim()) {
      store.bindSession(sessionId, identifier(req.body.snapshotId, 'snapshotId'));
    } else {
      const front = (await driver.list({ signal })).find((row) => row.frontmost);
      if (!front) throw new WindowOperationError('window-gone', 'no-frontmost-window');
      const snapshot = store.capture(front);
      store.bindSession(sessionId, snapshot.snapshotId);
    }
    res.json({ success: true, window: store.summary(sessionId) });
  }));
  router.post('/observe', asyncWindow(async (req, res, signal) => {
    const id = identifier(req.body?.snapshotId, 'snapshotId');
    const snapshot = await store.observe(id, driver, { signal, capture: req.body?.capture === true, elements: req.body?.elements !== false });
    res.json({ success: true, snapshot });
  }));
  router.post('/act', asyncWindow(async (req, res, signal) => {
    const id = identifier(req.body?.snapshotId, 'snapshotId');
    const result = await store.act(id, typeof req.body?.kind === 'string' ? req.body.kind : 'ax', req.body?.action, driver, { signal });
    if (!result.ok) {
      res.status(statusFor(result.reason)).json({ success: false, error: result.reason, ...result });
      return;
    }
    res.json({ success: true, snapshot: result.snapshot, receipt: result.receipt });
  }));
  return router;
}

export default createExactWindowRouter();
