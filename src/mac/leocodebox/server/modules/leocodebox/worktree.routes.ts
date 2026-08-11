import express from 'express';

import { requireLocalOnly } from '../../shared/local-only.js';

import {
  createWorktree,
  discardWorktree,
  listWorktrees,
  mergeWorktree,
  previewMerge,
  scanWorktreeOrphans,
  worktreeStatus,
} from './worktree.service.js';

const router = express.Router();

/** List worktrees (optionally for one project) + orphan set. */
router.get('/', async (req, res, next) => {
  try {
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    res.json({ success: true, worktrees: listWorktrees(projectPath), orphans: await scanWorktreeOrphans(projectPath) });
  } catch (error) {
    next(error);
  }
});

/** Create a worktree for a project. Body: { projectPath, slug }. */
router.post('/', requireLocalOnly, async (req, res, next) => {
  try {
    const worktree = await createWorktree(String(req.body?.projectPath || ''), String(req.body?.slug || ''));
    res.status(201).json({ success: true, worktree });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/status', async (req, res, next) => {
  try {
    res.json({ success: true, status: await worktreeStatus(req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** No-mutation conflict preview before merging. */
router.get('/:id/preview-merge', async (req, res, next) => {
  try {
    res.json({ success: true, ...(await previewMerge(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/merge', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: true, ...(await mergeWorktree(req.params.id, { squash: Boolean(req.body?.squash) })) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireLocalOnly, async (req, res, next) => {
  try {
    res.json({ success: true, ...(await discardWorktree(req.params.id, { force: req.query.force === 'true' })) });
  } catch (error) {
    next(error);
  }
});

export default router;
