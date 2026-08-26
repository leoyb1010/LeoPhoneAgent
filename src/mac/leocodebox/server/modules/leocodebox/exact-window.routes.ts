import express from 'express';

import { exactWindows, type WindowActionKind } from './exact-window.js';
import { bindFrontmostToSession, captureListed, listMacWindows } from './exact-window-macos.js';

const router: express.Router = express.Router();

router.get('/', (_req, res) => {
  const windows = listMacWindows().map((row) => {
    const snap = captureListed(row);
    return {
      ...row,
      machine: snap.ref.machine,
      snapshot_id: snap.snapshotId,
    };
  });
  res.json({ success: true, windows });
});

router.post('/bind', (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  const snapshotId = String(req.body?.snapshotId ?? '').trim();
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId required' });
    return;
  }
  try {
    if (snapshotId) {
      exactWindows.bindSession(sessionId, snapshotId);
    } else {
      const snap = bindFrontmostToSession(sessionId);
      if (!snap) {
        res.status(409).json({ success: false, error: 'no-frontmost-window' });
        return;
      }
    }
    res.json({ success: true, window: exactWindows.summary(sessionId) });
  } catch (error) {
    res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'bind-failed' });
  }
});

router.post('/observe', (req, res) => {
  const snapshotId = String(req.body?.snapshotId ?? '').trim();
  try {
    res.json({ success: true, snapshot: exactWindows.observe(snapshotId) });
  } catch (error) {
    res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'observe-failed' });
  }
});

router.post('/act', (req, res) => {
  const snapshotId = String(req.body?.snapshotId ?? '').trim();
  const kind = String(req.body?.kind ?? 'ax') as WindowActionKind;
  const result = exactWindows.act(snapshotId, kind);
  if (!result.ok) {
    res.status(409).json({ success: false, ...result });
    return;
  }
  res.json({ success: true, snapshot: result.snapshot });
});

export default router;
