import express from 'express';

import { listArsenal } from '@/shared/model-arsenal.js';

import { estimateClaudeQuota, getClaudePlan, setClaudePlan } from './claude-quota.service.js';
import { getModelPrices, setModelPrices, usageDb } from './usage.db.js';

const router = express.Router();
// Model Arsenal: per-model context window / pricing / capabilities, for the
// Leoapi录入 UI and cost display. Grouped by provider on the client.
router.get('/arsenal', (_req, res) => res.json({ success: true, models: listArsenal() }));
router.get('/prices', (_req, res) => res.json({ success: true, prices: getModelPrices() }));
router.put('/prices', (req, res) => res.json({ success: true, prices: setModelPrices(req.body?.prices) }));
router.get('/summary', (req, res) => {
  const read = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  res.json({ success: true, rows: usageDb.summary({
    from: read(req.query.from),
    to: read(req.query.to),
    projectPath: read(req.query.projectPath),
    provider: read(req.query.provider),
  }) });
});

// Claude subscription quota estimate — a LOCAL estimate from session logs,
// not an official account query. See claude-quota.service.ts.
router.get('/claude-quota', async (_req, res, next) => {
  try {
    res.json({ success: true, quota: await estimateClaudeQuota() });
  } catch (error) {
    next(error);
  }
});
router.get('/claude-quota/plan', (_req, res) => res.json({ success: true, plan: getClaudePlan() }));
router.put('/claude-quota/plan', (req, res) => res.json({ success: true, plan: setClaudePlan(req.body?.plan) }));
export default router;
