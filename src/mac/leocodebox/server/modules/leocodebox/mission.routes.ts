import express from 'express';

import { requireLocalOnly } from '../../shared/local-only.js';

import {
  completeMissionCard,
  createMissionCard,
  deleteMissionCard,
  discardMissionCard,
  listMissionCards,
  retryMissionCard,
  startMissionCard,
  transitionMissionCard,
} from './mission.service.js';

const router = express.Router();

function readUserId(req: express.Request): number {
  const userId = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    const error = new Error('Authentication required.') as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return userId;
}

router.get('/', (req, res, next) => {
  try {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    res.json({ success: true, cards: listMissionCards(readUserId(req), projectPath) });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireLocalOnly, (req, res, next) => {
  try {
    const card = createMissionCard(readUserId(req), {
      projectPath: String(req.body?.projectPath || ''),
      title: String(req.body?.title || ''),
      goal: String(req.body?.goal || ''),
      profileId: req.body?.profileId ? String(req.body.profileId) : undefined,
      slot: req.body?.slot ? String(req.body.slot) : undefined,
    });
    res.status(201).json({ success: true, card });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/start', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: true, card: await startMissionCard(readUserId(req), req.params.id) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/retry', requireLocalOnly, (req, res, next) => {
  try {
    res.json({ success: true, card: retryMissionCard(readUserId(req), req.params.id, { slot: req.body?.slot ? String(req.body.slot) : undefined }) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/transition', requireLocalOnly, (req, res, next) => {
  try {
    res.json({ success: true, card: transitionMissionCard(readUserId(req), req.params.id, req.body?.to) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/complete', requireLocalOnly, (req, res, next) => {
  try {
    const cost = req.body?.costUsd !== undefined ? Number(req.body.costUsd) : undefined;
    res.json({ success: true, card: completeMissionCard(readUserId(req), req.params.id, cost) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/discard', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: true, card: await discardMissionCard(readUserId(req), req.params.id, { force: req.query.force === 'true' }) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireLocalOnly, (req, res, next) => {
  try {
    res.json({ success: deleteMissionCard(readUserId(req), req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
