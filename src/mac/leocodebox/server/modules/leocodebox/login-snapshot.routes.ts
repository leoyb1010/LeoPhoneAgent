import express from 'express';

import { requireLocalOnly } from '../../shared/local-only.js';

import {
  applySnapshot,
  captureSnapshot,
  deleteSnapshot,
  isSnapshotTarget,
  listSnapshots,
} from './login-snapshot.service.js';

const router = express.Router();

router.get('/:target', async (req, res, next) => {
  try {
    if (!isSnapshotTarget(req.params.target)) { res.status(400).json({ success: false, error: 'Unsupported target.' }); return; }
    res.json({ success: true, snapshots: await listSnapshots(req.params.target) });
  } catch (error) {
    next(error);
  }
});

router.post('/:target', requireLocalOnly, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, snapshot: await captureSnapshot(req.params.target, String(req.body?.name || '')) });
  } catch (error) {
    next(error);
  }
});

router.post('/:target/:name/apply', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: true, ...(await applySnapshot(req.params.target, req.params.name)) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:target/:name', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: await deleteSnapshot(req.params.target, req.params.name) });
  } catch (error) {
    next(error);
  }
});

export default router;
